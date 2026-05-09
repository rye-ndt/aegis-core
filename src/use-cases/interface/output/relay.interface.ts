/**
 * Cross-chain swap provider (relay.link). Keeps the use-case layer
 * independent of the HTTP transport and Relay's wire format.
 */

export interface RelayQuoteRequest {
  /** SCA / EOA address initiating the swap. */
  user: string;
  /** Destination wallet for the output token. Usually the same as `user`. */
  recipient: string;
  originChainId: number;
  destinationChainId: number;
  /** ERC-20 contract address, or the zero address for native currency. */
  originCurrency: string;
  destinationCurrency: string;
  /** Raw amount (wei-precision string) of the origin token. */
  amount: string;
  tradeType: "EXACT_INPUT" | "EXACT_OUTPUT";
  /**
   * Slippage tolerance in basis points (e.g. 100 = 1%). Forwarded to Relay as
   * the `slippageTolerance` string field. Omit to let Relay auto-pick — but
   * the auto value is too tight for small swaps and trips
   * `QUOTE_SWAP_AMOUNT_TOO_SMALL` on simulation, so callers should set it.
   */
  slippageBps?: number;
  /** Referrer identifier surfaced in Relay analytics; opt-in. */
  referrer?: string;
}

export interface RelayTx {
  to: string;
  data: string;
  value: string;
}

/**
 * One step of the quote — typically `approve` or `swap`. The array of
 * `items` flattens into individual transactions the user's wallet must
 * submit. Only the shape consumed by `RelaySwapTool` is declared here;
 * any extra Relay metadata is carried through unchecked.
 */
export interface RelayQuoteStep {
  id?: string;
  action?: string;
  description?: string;
  kind?: string;
  items: Array<{
    status?: string;
    data: RelayTx;
  }>;
}

export interface RelayQuote {
  steps: RelayQuoteStep[];
  details?: {
    currencyIn?: { amount?: string; amountFormatted?: string };
    currencyOut?: { amount?: string; amountFormatted?: string };
  };
  fees?: Record<string, unknown>;
}

/**
 * Stage-4 (prediction-market bets): cross-chain bridge needs to know when
 * USDC has actually landed on Polygon before kicking off the SCA→EOA transfer.
 * Relay's `requestId` (returned alongside the quote and surfaced again from
 * the FE-side execute step) is the correlation key — `awaitIntent` polls
 * Relay's status endpoint until the intent reaches a terminal state.
 */
export type RelayIntentStatus = "pending" | "success" | "failure" | "refund";

export interface RelayIntentStatusResult {
  status: RelayIntentStatus;
  /** Free-form provider message, surfaced on failure/refund for debugging. */
  reason?: string;
  /** Echo of the input id so callers can correlate without bookkeeping. */
  requestId: string;
}

export interface IRelayClient {
  getQuote(request: RelayQuoteRequest): Promise<RelayQuote>;
  /**
   * One-shot status fetch. Implementations normalize provider-specific shape
   * into `RelayIntentStatus`. Returns `pending` when the intent is still in
   * flight; callers loop with backoff via `awaitIntent`.
   */
  getIntentStatus(requestId: string): Promise<RelayIntentStatusResult>;
  /**
   * Poll `getIntentStatus` until the result is terminal or `timeoutMs`
   * elapses. Resolves with the last observed result. Throws only on
   * unexpected adapter errors — a `pending` timeout is reported via
   * `status: "pending"`, not thrown.
   */
  awaitIntent(requestId: string, timeoutMs: number): Promise<RelayIntentStatusResult>;
}
