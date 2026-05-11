/**
 * Stage-4 Polymarket adapter port.
 *
 * Wraps the Polymarket CLOB integration so the place-bet capability never
 * touches HTTP/SDK details directly. The adapter owns:
 *   - L1 → L2 auth (one-time per user; secrets returned + stored encrypted)
 *   - signed-order construction (BE-side helper for orders the FE pre-signed)
 *   - order POST/cancel + fill polling
 *   - orderbook top-of-book reads
 *
 * Polymarket-specific knowledge (EIP-712 domain, sigType enum, HMAC header
 * shape) lives entirely behind this interface so the capability layer stays
 * adapter-agnostic.
 */

export interface PolymarketCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface OrderbookTopOfBook {
  /** Best bid price as a 0..1 decimal (probability of YES). */
  bestBidPrice: number;
  /** Best ask price as a 0..1 decimal. */
  bestAskPrice: number;
  /** Mid price = (bid + ask) / 2. Convenience for drift checks. */
  midPrice: number;
}

export interface PlaceOrderInput {
  /** EIP-712 EOA-maker signature already produced by the FE/session-key. */
  signature: `0x${string}`;
  /** Polymarket order tuple — adapter forwards verbatim to /order. */
  order: SignedPolymarketOrder;
  /** Idempotency key on the BE side; Polymarket uses `clientOrderId` too. */
  clientOrderId: string;
  /** AES-encrypted cred envelope for L2 HMAC. Adapter decrypts internally. */
  polymarketCredsEnc: string;
  /** Maker EOA address; populates the `POLY_ADDRESS` L2 HMAC header. */
  makerAddress: `0x${string}`;
  userId: string;
}

/**
 * Shape of an EOA-signed Polymarket order. Field names match the on-chain
 * struct verified by the CTFExchange. Mirrors `SignedOrder` from
 * `@polymarket/clob-client`.
 */
export interface SignedPolymarketOrder {
  salt: string;
  maker: `0x${string}`;
  signer: `0x${string}`;
  taker: `0x${string}`;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: "BUY" | "SELL";
  /** Polymarket signature type enum: 0 = EOA (plain ECDSA). */
  signatureType: 0 | 1 | 2;
}

export interface PlaceOrderResult {
  polymarketOrderId: string;
  /** Provider response status (`matched` / `live` / `delayed`). */
  status: string;
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

export interface DeriveCredsInput {
  userId: string;
  /** EOA signature over Polymarket's L1 EIP-712 "Generate API key" payload. */
  l1Signature: `0x${string}`;
  /** Nonce used in the L1 payload — echoed back to /auth/api-key. */
  nonce: string;
  /** Address that produced the L1 signature (= maker EOA). */
  address: `0x${string}`;
}

export interface IPolymarketAdapter {
  /**
   * Derives L2 HMAC creds via Polymarket's `/auth/api-key`. Returns the raw
   * creds; the caller is responsible for AES-encrypting them and persisting
   * via `IPredictionMarketBetRepository.setPolymarketCredsEnc`.
   */
  deriveApiKey(input: DeriveCredsInput): Promise<PolymarketCreds>;

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

  /** POST /order with HMAC L2 headers. */
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;

  /** Cancel a live or partially-filled order. */
  cancelOrder(polymarketOrderId: string, polymarketCredsEnc: string, makerAddress: `0x${string}`): Promise<void>;

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
