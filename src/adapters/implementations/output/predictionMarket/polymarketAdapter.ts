import { createHmac } from "node:crypto";
import { LRUCache } from "lru-cache";
import { aesDecrypt } from "../../../../helpers/crypto/aesGcm";
import { PREDICTION_MARKETS_ENV } from "../../../../helpers/env/predictionMarketEnv";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  DeriveCredsInput,
  IPolymarketAdapter,
  OrderbookTopOfBook,
  OrderFillStatus,
  PlaceOrderInput,
  PlaceOrderResult,
  PolymarketCreds,
  PolymarketPositionView,
} from "../../../../use-cases/interface/predictionMarket/IPolymarketAdapter";

const log = createLogger("polymarketAdapter");

const TOB_CACHE_MS = 2_000;
const PRICE_TO_BPS = 10_000;

/**
 * Polymarket CLOB adapter. Talks to the public HTTP API directly: pulling in
 * `@polymarket/clob-client` would drag ethers v5 into a viem-only stack. The
 * EIP-712 order signing happens FE-side using the session key; this adapter
 * forwards the pre-signed tuple (with the signature included on the inner
 * order object per CLOB convention) and attaches L2 HMAC headers.
 *
 * Header set (`POLY_ADDRESS` / `POLY_SIGNATURE` / `POLY_TIMESTAMP` /
 * `POLY_API_KEY` / `POLY_PASSPHRASE`) and HMAC payload (`timestamp + method +
 * path + body` keyed with the base64-decoded L2 secret, base64url-encoded
 * digest) match `@polymarket/clob-client@^4` exactly.
 */
export class PolymarketAdapter implements IPolymarketAdapter {
  private readonly tobCache = new LRUCache<string, OrderbookTopOfBook>({
    max: 500,
    ttl: TOB_CACHE_MS,
  });

  constructor(private readonly baseUrl: string = PREDICTION_MARKETS_ENV.clobApiBase) {}

  async deriveApiKey(input: DeriveCredsInput): Promise<PolymarketCreds> {
    log.info({ userId: input.userId, step: "derive-api-key" }, "polymarket-auth");
    const url = `${this.baseUrl}/auth/api-key`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      POLY_ADDRESS: input.address,
      POLY_SIGNATURE: input.l1Signature,
      POLY_TIMESTAMP: String(Math.floor(Date.now() / 1000)),
      POLY_NONCE: input.nonce,
    };
    const response = await fetch(url, { method: "POST", headers, body: "{}" });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log.error(
        { status: response.status, userId: input.userId, body: text.slice(0, 200) },
        "derive-api-key-failed",
      );
      throw new Error(`POLYMARKET_AUTH_FAILED: HTTP ${response.status}`);
    }
    const json = (await response.json()) as PolymarketCreds;
    if (!json.apiKey || !json.secret || !json.passphrase) {
      throw new Error("POLYMARKET_AUTH_INVALID_RESPONSE");
    }
    return json;
  }

  async getOrderbookTopOfBook(tokenId: string): Promise<OrderbookTopOfBook> {
    const cached = this.tobCache.get(tokenId);
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
      bids?: Array<{ price: string }>;
      asks?: Array<{ price: string }>;
    };
    const bestBidPrice = parseTopLevel(json.bids);
    const bestAskPrice = parseTopLevel(json.asks);
    const result: OrderbookTopOfBook = {
      bestBidPrice,
      bestAskPrice,
      midPrice: (bestBidPrice + bestAskPrice) / 2,
    };
    this.tobCache.set(tokenId, result);
    return result;
  }

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const creds = this.unsealCreds(input.polymarketCredsEnc);
    const body = JSON.stringify({
      // Polymarket's `/order` endpoint expects the EIP-712 signature as a
      // field on the order tuple itself, not a sibling. Without it the CLOB
      // can't verify the EOA-maker authority and 4xx's the request.
      order: { ...input.order, signature: input.signature },
      owner: input.order.maker,
      orderType: "GTC",
      clientOrderId: input.clientOrderId,
    });
    const path = "/order";
    const headers = this.l2Headers(creds, input.makerAddress, "POST", path, body);
    log.debug({ userId: input.userId, clientOrderId: input.clientOrderId }, "post-order");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const level = response.status >= 500 ? "error" : "warn";
      log[level](
        { status: response.status, userId: input.userId, body: text.slice(0, 200) },
        "post-order-failed",
      );
      throw new Error(`POLYMARKET_ORDER_FAILED: HTTP ${response.status}`);
    }
    const json = (await response.json()) as { orderId?: string; status?: string };
    if (!json.orderId) throw new Error("POLYMARKET_ORDER_INVALID_RESPONSE");
    log.info(
      { userId: input.userId, polymarketOrderId: json.orderId, status: json.status },
      "post-order-ok",
    );
    return { polymarketOrderId: json.orderId, status: json.status ?? "live" };
  }

  async cancelOrder(
    polymarketOrderId: string,
    polymarketCredsEnc: string,
    makerAddress: `0x${string}`,
  ): Promise<void> {
    const creds = this.unsealCreds(polymarketCredsEnc);
    const body = JSON.stringify({ orderId: polymarketOrderId });
    const path = "/order";
    const headers = this.l2Headers(creds, makerAddress, "DELETE", path, body);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers,
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log.warn(
        { status: response.status, polymarketOrderId, body: text.slice(0, 200) },
        "cancel-order-failed",
      );
      throw new Error(`POLYMARKET_CANCEL_FAILED: HTTP ${response.status}`);
    }
    log.info({ polymarketOrderId }, "cancel-order-ok");
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
   * encoded.
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
