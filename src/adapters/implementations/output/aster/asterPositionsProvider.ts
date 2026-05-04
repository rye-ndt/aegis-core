import { formatUnits } from "viem";
import type {
  IStockPositionsProvider,
  StockPosition,
} from "../../../../use-cases/interface/output/stocks/stockPositionsProvider.interface";
import type { IStockPairRegistry } from "../../../../use-cases/interface/output/stocks/stockPair.interface";
import type { AsterDiamondClient } from "./asterDiamond.client";
import { ASTER_READER_ABI } from "./asterAbi";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("asterPositionsProvider");

/**
 * Reader for the SCA's open Aster stock positions.
 *
 * The `getPositionsV2` output struct shape is a candidate (see
 * `asterAbi.ts` — POSITION_TUPLE) — Aster's Diamond reader source is not
 * open and the BscScan source is unverified. `mapRawPosition()` therefore
 * decodes defensively: any field whose value violates basic invariants
 * (zero price, unknown pairBase) causes the entry to be dropped with a
 * `warn` log and the rest of the list is returned. Phase 3 (close / SL /
 * TP) is the first user-visible consumer; until the struct is verified, a
 * regression here will manifest as "no open positions" rather than wrong
 * data.
 *
 * TODO_VERIFY_ABI(positions): when verified source lands, simplify
 * `mapRawPosition` and remove the per-field tolerance.
 */
export class AsterPositionsProvider implements IStockPositionsProvider {
  constructor(
    private readonly diamond: AsterDiamondClient,
    private readonly pairs: IStockPairRegistry,
    /**
     * Decimals of the venue collateral token. Sourced from the broker
     * provider's `collateralToken.decimals` so positions formatting stays
     * correct if Aster ever switches off USDC.bsc — the chain-config rule
     * forbids hardcoding decimals here.
     */
    private readonly collateralDecimals: number,
  ) {}

  async list(trader: `0x${string}`): Promise<StockPosition[]> {
    const start = Date.now();
    let raw: readonly RawPosition[];
    try {
      raw = (await this.diamond.publicClient.readContract({
        address: this.diamond.diamondAddress,
        abi: ASTER_READER_ABI,
        functionName: "getPositionsV2",
        args: [trader],
      })) as readonly RawPosition[];
    } catch (err) {
      log.error({ err, trader }, "getPositionsV2 read failed");
      throw err;
    }

    // Build pairBase → symbol map from the pair registry so we can drop
    // forex/commodities/crypto positions and surface only the supported
    // stock symbols.
    const pairBaseToSymbol = new Map<string, string>();
    for (const sym of this.pairs.symbols()) {
      const pb = this.pairs.resolve(sym);
      if (pb) pairBaseToSymbol.set(pb.toLowerCase(), sym);
    }

    const positions: StockPosition[] = [];
    let dropped = 0;
    for (const r of raw) {
      const mapped = this.mapRawPosition(r, pairBaseToSymbol);
      if (mapped) positions.push(mapped);
      else dropped += 1;
    }

    log.debug(
      {
        trader,
        count: positions.length,
        dropped,
        durationMs: Date.now() - start,
      },
      "positions fetched",
    );
    return positions;
  }

  /**
   * Map a single raw struct entry to the domain type. Returns null when the
   * row violates a basic invariant (entry price is zero, pairBase is not a
   * known stock symbol). Logs at `warn` so we can spot decode drift in
   * production without crashing the close/SL/TP flow.
   */
  private mapRawPosition(
    r: RawPosition,
    pairBaseToSymbol: Map<string, string>,
  ): StockPosition | null {
    try {
      const pairKey = (r.pairBase as string).toLowerCase();
      const symbol = pairBaseToSymbol.get(pairKey);
      if (!symbol) return null; // not a tracked stock pair
      if (BigInt(r.entryPrice) === 0n) {
        log.warn({ tradeHashShort: shortHash(r.tradeHash) }, "drop position with zero entry price");
        return null;
      }
      return {
        tradeHash: r.tradeHash,
        symbol,
        side: r.isLong ? "long" : "short",
        entryPriceUsd: formatPrice1e8(r.entryPrice),
        markPriceUsd: formatPrice1e8(r.markPrice),
        collateralUsd: formatUnits(BigInt(r.marginUsd), this.collateralDecimals),
        notionalUsd: computeNotional(r.qty, r.markPrice),
        unrealizedPnlUsd: formatPnl(r.pnlUsd, this.collateralDecimals),
        stopLossUsd: BigInt(r.stopLoss) === 0n ? null : formatPrice1e8(r.stopLoss),
        takeProfitUsd: BigInt(r.takeProfit) === 0n ? null : formatPrice1e8(r.takeProfit),
        openedAtEpoch: Number(r.timestamp),
      };
    } catch (err) {
      log.warn(
        { err, tradeHashShort: shortHash(r.tradeHash ?? "0x") },
        "mapRawPosition failed — skipping entry",
      );
      return null;
    }
  }
}

/**
 * Cached wrapper around `AsterPositionsProvider`. Per-process in-memory
 * cache (Redis isn't a fit — these reads are per-user and short-lived).
 * Cache key includes the trader so a single process serving many users
 * doesn't bleed state across them. Locked TTL: 60 s (per impl plan).
 */
type PosCacheEntry = { positions: StockPosition[]; expiresAt: number };
const posLog = createLogger("cachedStockPositionsProvider");

export class CachedStockPositionsProvider implements IStockPositionsProvider {
  private readonly cache = new Map<string, PosCacheEntry>();
  private readonly ttlMs: number;
  constructor(
    private readonly inner: IStockPositionsProvider,
    opts: { ttlSec: number },
  ) {
    this.ttlMs = opts.ttlSec * 1000;
  }

  async list(trader: `0x${string}`): Promise<StockPosition[]> {
    const key = trader.toLowerCase();
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) {
      posLog.debug({ choice: "hit", count: hit.positions.length }, "positions-cache");
      return hit.positions;
    }
    posLog.debug({ choice: "miss" }, "positions-cache");
    const fresh = await this.inner.list(trader);
    this.cache.set(key, { positions: fresh, expiresAt: now + this.ttlMs });
    return fresh;
  }
}

interface RawPosition {
  tradeHash: `0x${string}`;
  pairBase: `0x${string}`;
  user: `0x${string}`;
  isLong: boolean;
  tokenIn: `0x${string}`;
  marginUsd: bigint;
  qty: bigint;
  entryPrice: bigint;
  stopLoss: bigint;
  takeProfit: bigint;
  timestamp: bigint;
  markPrice: bigint;
  pnlUsd: bigint;
  fundingFeeUsd: bigint;
  rolloverFeeUsd: bigint;
}

function formatPrice1e8(v: bigint | string): string {
  // 1e8 fixed-point USD → human "189.42".
  return formatUnits(BigInt(v), 8);
}

function computeNotional(qty1e10: bigint | string, markPrice1e8: bigint | string): string {
  // notional_usd = qty * mark = (qty/1e10) * (mark/1e8) → in USD.
  // Avoid floats: multiply BigInts then re-scale to 1e8 to reuse formatter.
  const product = BigInt(qty1e10) * BigInt(markPrice1e8);
  // product is scaled by 1e18; we want 1e8 output (cents-of-cents) for the formatter.
  const scaled = product / 10n ** 10n;
  return formatUnits(scaled, 8);
}

function formatPnl(v: bigint | string, decimals: number): string {
  // P&L sign-aware. Aster `pnlUsd` is denominated in collateral-token
  // units, so decimals must match `collateralToken.decimals` (18 on
  // BSC). Hardcoding 6 here would produce a 10^12 display error on BSC.
  const big = BigInt(v);
  const abs = big < 0n ? -big : big;
  const human = formatUnits(abs, decimals);
  return big < 0n ? `-${human}` : human;
}

function shortHash(h: string): string {
  return h.length > 12 ? `${h.slice(0, 10)}…` : h;
}
