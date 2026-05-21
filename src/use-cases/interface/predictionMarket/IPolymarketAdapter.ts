/**
 * Stage-4 Polymarket adapter port. **Read-only as of Slice E (2026-05-21).**
 *
 * The pre-Slice-E adapter owned three FE-facing write paths: L1→L2 auth
 * (`/auth/api-key` returning `apiKey` / `secret` / `passphrase`), `POST /order`,
 * and `DELETE /order`. Those moved off the BE entirely: orders are signed in
 * the mini-app from the queued EIP-712 sign request and submitted directly to
 * `clob.polymarket.com` by the FE, which holds the HMAC creds in
 * Telegram CloudStorage. The BE never sees signatures, never sees creds, never
 * POSTs to Polymarket — only reads.
 *
 * Non-custodial invariant: nothing in this port returns or carries a
 * signature, EIP-712 message, or unsealed credential. CI grep gate
 * (`npm run check:no-clob-secrets`) fails if a new caller reintroduces
 * `apiKey` / `passphrase` / `placeOrder` / `cancelOrder` / `deriveApiKey`
 * outside the existing HMAC-bearing read paths.
 *
 * Surviving read methods (`getOrderStatus`, `getPositions`) still use the
 * Polymarket L2 HMAC headers because the `/data/order/:id` and
 * `/data/positions?user=…` endpoints are L2-protected. The HMAC payload is
 * built from creds previously written via the (now-removed) `storePolymarketCreds`
 * write path — existing rows remain valid; the `polymarket_creds_enc` column
 * drops in a follow-up migration after the 30-day deprecation window.
 */

export interface OrderbookTopOfBook {
  /** Best bid price as a 0..1 decimal (probability of YES). */
  bestBidPrice: number;
  /** Best ask price as a 0..1 decimal. */
  bestAskPrice: number;
  /** Mid price = (bid + ask) / 2. Convenience for drift checks. */
  midPrice: number;
}

export interface OrderFillStatus {
  polymarketOrderId: string;
  /** Sum of filled size, decimal string. */
  filledShares: string;
  /** Volume-weighted average fill price, in basis points (0..10000). */
  avgPriceBps: number;
  /** Provider state ("LIVE" / "MATCHED" / "CANCELED" / …). */
  state: string;
  /** True when `filledShares >= requestedShares`. */
  isFilled: boolean;
  /** True when the order is no longer accepting fills. */
  isTerminal: boolean;
}

export interface IPolymarketReadAdapter {
  /** Live top-of-book for a YES/NO outcome token. Cached ~2s by impl. */
  getOrderbookTopOfBook(tokenId: string): Promise<OrderbookTopOfBook>;

  /**
   * Order-book depth for the LP sizer. Returns up to `depthLevels` rungs on
   * the requested side, best price first (asks ascending for BUY, bids
   * descending for SELL). Backed by the same `/book?token_id=` payload the
   * top-of-book call parses; consumers should share a `verifyFreshnessMs`-
   * windowed cache.
   */
  getOrderbookDepth(args: {
    outcomeTokenId: string;
    side: "BUY" | "SELL";
    depthLevels: number;
  }): Promise<Array<{ priceFraction: number; shares: number }>>;

  /** Single-shot fill status. Caller polls; this method is stateless. */
  getOrderStatus(polymarketOrderId: string, polymarketCredsEnc: string, makerAddress: `0x${string}`): Promise<OrderFillStatus>;

  /**
   * Authoritative on-chain position view per Polymarket. Used by the position
   * poller to reconcile against our local `predictionMarketPositions` rows
   * (manual closes via Polymarket web, partial fills missed at submit time,
   * resolution events). Pulls `/data/positions?user=<addr>`.
   */
  getPositions(input: {
    makerAddress: `0x${string}`;
    polymarketCredsEnc: string;
  }): Promise<PolymarketPositionView[]>;
}

/** Minimal slice of Polymarket's position payload used for reconciliation. */
export interface PolymarketPositionView {
  marketId: string;
  outcomeTokenId: string;
  /** Decimal-string share count currently held. `0` after a full close. */
  sizeShares: string;
  /** Volume-weighted entry price in basis points. */
  avgPriceBps: number;
  /** Current mark-to-market value of the holding in USDC cents. Optional. */
  currentValueUsdcCents: number | null;
  /** Polymarket marks the market as resolved; `redeemable` is on-chain truth. */
  resolved: boolean;
  /** "YES" / "NO" / outcome string when `resolved=true`. */
  resolvedOutcome: string | null;
  /** Settled USDC delivered to the EOA, in cents. Null until claimed. */
  realizedPnlUsdcCents: number | null;
}
