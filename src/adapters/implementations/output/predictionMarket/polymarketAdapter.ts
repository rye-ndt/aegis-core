import { createHmac } from "node:crypto";
import { LRUCache } from "lru-cache";
import { aesDecrypt } from "../../../../helpers/crypto/aesGcm";
import { PREDICTION_MARKETS_ENV } from "../../../../helpers/env/predictionMarketEnv";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  IPolymarketReadAdapter,
  OrderbookTopOfBook,
  OrderFillStatus,
  PolymarketPositionView,
} from "../../../../use-cases/interface/predictionMarket/IPolymarketAdapter";

/** L2 HMAC creds for Polymarket — never leaves this file. */
interface PolymarketCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
}

const log = createLogger("polymarketAdapter");

const TOB_CACHE_MS = 2_000;
const PRICE_TO_BPS = 10_000;

type BookLevel = { price: string; size?: string };
type BookEntry = {
  tob: OrderbookTopOfBook;
  bids: BookLevel[];
  asks: BookLevel[];
};

/** Polymarket CLOB read-only adapter — see {@link IPolymarketReadAdapter}. */
export class PolymarketAdapter implements IPolymarketReadAdapter {
  // Single cache holding both the parsed top-of-book and the raw rungs the
  // sizer needs. Written together on miss; expired together.
  private readonly bookCache = new LRUCache<string, BookEntry>({
    max: 500,
    ttl: TOB_CACHE_MS,
  });

  constructor(private readonly baseUrl: string = PREDICTION_MARKETS_ENV.clobApiBase) {}

  async getOrderbookTopOfBook(tokenId: string): Promise<OrderbookTopOfBook> {
    return (await this.fetchBook(tokenId)).tob;
  }

  private async fetchBook(tokenId: string): Promise<BookEntry> {
    const cached = this.bookCache.get(tokenId);
    if (cached) {
      log.debug({ choice: "hit", tokenId }, "tob-cache");
      return cached;
    }
    log.debug({ choice: "miss", tokenId }, "tob-cache");

    const url = `${this.baseUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log.warn({ status: response.status, tokenId, body: text.slice(0, 200) }, "tob-http-error");
      throw new Error(`POLYMARKET_BOOK_FAILED: HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      bids?: BookLevel[];
      asks?: BookLevel[];
    };
    const bestBidPrice = parseTopLevel(json.bids);
    const bestAskPrice = parseTopLevel(json.asks);
    const entry: BookEntry = {
      tob: {
        bestBidPrice,
        bestAskPrice,
        midPrice: (bestBidPrice + bestAskPrice) / 2,
      },
      bids: json.bids ?? [],
      asks: json.asks ?? [],
    };
    this.bookCache.set(tokenId, entry);
    return entry;
  }

  async getOrderbookDepth(args: {
    outcomeTokenId: string;
    side: "BUY" | "SELL";
    depthLevels: number;
  }): Promise<Array<{ priceFraction: number; shares: number }>> {
    const book = await this.fetchBook(args.outcomeTokenId);
    // BUY consumes asks (best ask first, ascending price); SELL consumes
    // bids (best bid first, descending price).
    const rawLevels = args.side === "BUY" ? book.asks : book.bids;
    const sorted = [...rawLevels]
      .map((lvl) => ({ price: Number(lvl.price), size: Number(lvl.size ?? 0) }))
      .filter((lvl) => Number.isFinite(lvl.price) && lvl.size > 0)
      .sort((a, b) => (args.side === "BUY" ? a.price - b.price : b.price - a.price));
    return sorted
      .slice(0, args.depthLevels)
      .map(({ price, size }) => ({ priceFraction: price, shares: size }));
  }

  async getOrderStatus(
    polymarketOrderId: string,
    polymarketCredsEnc: string,
    makerAddress: `0x${string}`,
  ): Promise<OrderFillStatus> {
    const creds = this.unsealCreds(polymarketCredsEnc);
    const path = `/data/order/${encodeURIComponent(polymarketOrderId)}`;
    const headers = this.l2Headers(creds, makerAddress, "GET", path, "");
    const response = await fetch(`${this.baseUrl}${path}`, { method: "GET", headers });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log.warn(
        { status: response.status, polymarketOrderId, body: text.slice(0, 200) },
        "order-status-failed",
      );
      throw new Error(`POLYMARKET_STATUS_FAILED: HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      status?: string;
      sizeMatched?: string;
      originalSize?: string;
      avgPrice?: string;
    };
    const filledShares = json.sizeMatched ?? "0";
    const requestedShares = json.originalSize ?? filledShares;
    const avgPriceBps = Math.round(Number(json.avgPrice ?? 0) * PRICE_TO_BPS);
    const state = (json.status ?? "LIVE").toUpperCase();
    return {
      polymarketOrderId,
      filledShares,
      avgPriceBps,
      state,
      isFilled: Number(filledShares) >= Number(requestedShares),
      isTerminal: state === "MATCHED" || state === "CANCELED" || state === "FILLED",
    };
  }

  async getPositions(input: {
    makerAddress: `0x${string}`;
    polymarketCredsEnc: string;
  }): Promise<PolymarketPositionView[]> {
    const creds = this.unsealCreds(input.polymarketCredsEnc);
    const path = `/data/positions?user=${encodeURIComponent(input.makerAddress)}`;
    const headers = this.l2Headers(creds, input.makerAddress, "GET", path, "");
    const response = await fetch(`${this.baseUrl}${path}`, { method: "GET", headers });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log.warn(
        { status: response.status, makerAddress: input.makerAddress, body: text.slice(0, 200) },
        "positions-fetch-failed",
      );
      throw new Error(`POLYMARKET_POSITIONS_FAILED: HTTP ${response.status}`);
    }
    const json = (await response.json().catch(() => ({}))) as {
      positions?: Array<{
        marketId?: string;
        conditionId?: string;
        outcomeTokenId?: string;
        asset?: string;
        size?: string;
        avgPrice?: string;
        currentValue?: string;
        resolved?: boolean;
        outcome?: string;
        resolvedOutcome?: string;
        redeemableUsdc?: string;
        realizedPnl?: string;
      }>;
    };
    const rows = json.positions ?? [];
    const out: PolymarketPositionView[] = [];
    for (const r of rows) {
      const marketId = r.marketId ?? r.conditionId;
      const outcomeTokenId = r.outcomeTokenId ?? r.asset;
      if (!marketId || !outcomeTokenId) continue;
      out.push({
        marketId,
        outcomeTokenId,
        sizeShares: r.size ?? "0",
        avgPriceBps: Math.round(Number(r.avgPrice ?? 0) * PRICE_TO_BPS),
        currentValueUsdcCents:
          r.currentValue != null ? Math.round(Number(r.currentValue) * 100) : null,
        resolved: Boolean(r.resolved),
        resolvedOutcome: r.resolvedOutcome ?? r.outcome ?? null,
        realizedPnlUsdcCents:
          r.realizedPnl != null
            ? Math.round(Number(r.realizedPnl) * 100)
            : r.redeemableUsdc != null
              ? Math.round(Number(r.redeemableUsdc) * 100)
              : null,
      });
    }
    log.debug(
      { makerAddress: input.makerAddress, positions: out.length },
      "positions-fetched",
    );
    return out;
  }

  private unsealCreds(envelope: string): PolymarketCreds {
    const keyHex = PREDICTION_MARKETS_ENV.credsKeyHex;
    if (!keyHex) {
      throw new Error("POLYMARKET_CREDS_KEY_MISSING");
    }
    const json = aesDecrypt(envelope, keyHex);
    return JSON.parse(json) as PolymarketCreds;
  }

  /**
   * Polymarket L2 HMAC headers. Signature payload is `timestamp + method +
   * path + body`, HMAC-SHA-256 over the base64-decoded secret, base64url
   * encoded. Read-only after Slice E — body is always `""` (no writes).
   */
  private l2Headers(
    creds: PolymarketCreds,
    makerAddress: `0x${string}`,
    method: string,
    path: string,
    body: string,
  ): Record<string, string> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = `${timestamp}${method.toUpperCase()}${path}${body}`;
    const secret = Buffer.from(creds.secret, "base64");
    const signature = createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");
    return {
      "Content-Type": "application/json",
      POLY_ADDRESS: makerAddress,
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: timestamp,
      POLY_API_KEY: creds.apiKey,
      POLY_PASSPHRASE: creds.passphrase,
    };
  }
}

function parseTopLevel(side: Array<{ price: string }> | undefined): number {
  if (!side || side.length === 0) return 0;
  const top = side[0];
  if (!top) return 0;
  const n = Number(top.price);
  return Number.isFinite(n) ? n : 0;
}
