import { formatUnits } from "viem";
import type {
  IStockPriceOracle,
  StockMark,
} from "../../../../use-cases/interface/output/stocks/stockPriceOracle.interface";
import type { IStockPairRegistry } from "../../../../use-cases/interface/output/stocks/stockPair.interface";
import type { AsterDiamondClient } from "./asterDiamond.client";
import { ASTER_READER_ABI } from "./asterAbi";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("asterPriceOracle");

/** Aster mark prices are encoded as fixed-point 1e8 (USD). */
const PRICE_DECIMALS = 8;

interface MarketInfo {
  pairBase: `0x${string}`;
  longQty: bigint;
  shortQty: bigint;
  lpLongAvgPrice: bigint;
  lpShortAvgPrice: bigint;
  markPrice: bigint;
}

export class AsterPriceOracle implements IStockPriceOracle {
  constructor(
    private readonly diamond: AsterDiamondClient,
    private readonly pairs: IStockPairRegistry,
  ) {}

  async markPrice(symbol: string): Promise<StockMark> {
    const [m] = await this.markPrices([symbol]);
    if (!m) throw new Error(`unknown symbol ${symbol}`);
    return m;
  }

  async markPrices(symbols: readonly string[]): Promise<StockMark[]> {
    const requested = symbols.map((s) => s.trim().toUpperCase());
    const bases: `0x${string}`[] = [];
    const symBaseMap: Array<{ symbol: string; pairBase: `0x${string}` | null }> = [];
    for (const sym of requested) {
      const pb = this.pairs.resolve(sym);
      symBaseMap.push({ symbol: sym, pairBase: pb });
      if (pb) bases.push(pb);
    }
    if (bases.length === 0) {
      log.warn({ symbols: requested }, "markPrices: no resolvable symbols");
      return [];
    }

    const start = Date.now();
    const result = (await this.diamond.publicClient.readContract({
      address: this.diamond.diamondAddress,
      abi: ASTER_READER_ABI,
      functionName: "getMarketInfos",
      args: [bases],
    })) as readonly MarketInfo[];
    log.debug(
      { count: bases.length, durationMs: Date.now() - start },
      "marks fetched",
    );

    const byBase = new Map<string, MarketInfo>();
    for (const m of result) byBase.set(m.pairBase.toLowerCase(), m);

    const now = Math.floor(Date.now() / 1000);
    const marks: StockMark[] = [];
    for (const { symbol, pairBase } of symBaseMap) {
      if (!pairBase) continue;
      const m = byBase.get(pairBase.toLowerCase());
      if (!m) {
        log.warn({ symbol, pairBase }, "no market info returned for pair");
        continue;
      }
      marks.push({
        symbol,
        priceUsd: formatUnits(m.markPrice, PRICE_DECIMALS),
        asOfEpoch: now,
      });
    }
    return marks;
  }
}

type CacheEntry = { mark: StockMark; expiresAt: number };

/**
 * In-memory TTL cache for stock marks. Mirrors the `CachedBalanceProvider`
 * pattern; we don't need Redis here — the price oracle is a hot read path
 * and per-process caching is fine.
 */
export class CachedStockPriceOracle implements IStockPriceOracle {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(private readonly inner: IStockPriceOracle, opts: { ttlSec: number }) {
    this.ttlMs = opts.ttlSec * 1000;
  }

  async markPrice(symbol: string): Promise<StockMark> {
    const key = symbol.trim().toUpperCase();
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) {
      log.debug({ choice: "hit", symbol: key }, "price-cache");
      return hit.mark;
    }
    log.debug({ choice: "miss", symbol: key }, "price-cache");
    const fresh = await this.inner.markPrice(key);
    this.cache.set(key, { mark: fresh, expiresAt: now + this.ttlMs });
    return fresh;
  }

  async markPrices(symbols: readonly string[]): Promise<StockMark[]> {
    const now = Date.now();
    const out: StockMark[] = [];
    const misses: string[] = [];
    for (const raw of symbols) {
      const key = raw.trim().toUpperCase();
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > now) out.push(hit.mark);
      else misses.push(key);
    }
    if (misses.length > 0) {
      const fresh = await this.inner.markPrices(misses);
      for (const m of fresh) {
        this.cache.set(m.symbol, { mark: m, expiresAt: now + this.ttlMs });
        out.push(m);
      }
    }
    return out;
  }
}
