import type {
  BetIntentRow,
  BetRow,
  PositionRow,
  UserSetupRow,
} from "./IPredictionMarketBetRepository";
import type {
  Eip712Purpose,
  SigningRequestKind,
} from "../output/cache/signingRequest.cache";

/**
 * BE orchestration for stage-4 prediction-market bets.
 *
 * Owns: setup-state-machine transitions, intent lifecycle, bet/state
 * persistence, drift checks, refund bookkeeping. Does NOT sign UserOps or
 * EIP-712 orders — those are FE responsibilities, the use-case just records
 * the artifacts the FE produces.
 */

/**
 * HTTP-shape extension of `PositionRow` for the FE positions list. The DB row
 * stays unchanged; this DTO carries the cross-aggregate fields (market
 * metadata) the FE renders. Computed in the use-case so the join lives on
 * one side of the port boundary, not in the HTTP handler.
 */
export interface PositionListItem extends PositionRow {
  /** Human question text for the position's market, or a truncated-id fallback. */
  marketQuestion: string;
  /** `"YES"` or `"NO"` for binary markets (the only universe today). */
  outcomeLabel: string;
}

export interface InitiateBetIntentInput {
  userId: string;
  findingId: string | null;
  marketId: string;
  side: string;
  outcomeTokenId: string | null;
  refPriceBps: number | null;
}

export interface InitiateBetIntentResult {
  intent: BetIntentRow;
  setup: UserSetupRow | null;
  needsSetup: boolean;
  /** Min/max stake from env, surfaced to the chat prompt. */
  minStakeUsdc: number;
  maxStakeUsdc: number;
}

export interface ConfirmBetIntentInput {
  userId: string;
  intentId: string;
  /** Canonical client-side idempotency key for the Polymarket POST. */
  clientOrderId: string;
}

export interface SubmitAmountInput {
  userId: string;
  intentId: string;
  /** Whole USDC, validated against env min/max + balance preconditions. */
  stakeUsdc: number;
}

export type SubmitAmountResult =
  | { kind: "ok"; intent: BetIntentRow }
  | { kind: "rejected"; reason: "below-min" | "above-max" | "not-found" | "wrong-status" };

export interface FinalizeBetInput {
  userId: string;
  betId: string;
  outcome: "FILLED" | "PARTIAL" | "UNFILLED" | "FAILED";
  filledShares?: string;
  filledAvgPriceBps?: number;
  failureReason?: string;
}

export interface InitiateCloseInput {
  userId: string;
  positionId: string;
  /** Idempotency key for the eventual sell-side Polymarket order. */
  clientOrderId: string;
  /** Best-bid mid price for the outcome token, in basis points (drift check ref). */
  refPriceBps: number;
}

export interface ReconcileResult {
  /** Positions whose terminal/resolved state changed to `resolved` this tick. */
  resolved: PositionRow[];
  /** Positions whose currentValueUsdcCents was updated. */
  marked: PositionRow[];
  /** Local positions removed/closed because Polymarket no longer reports a holding. */
  closedFromPolymarket: PositionRow[];
}

export interface IPredictionMarketBetUseCase {
  /**
   * Idempotently records the user's Polygon SCA + EOA into
   * `predictionMarketUserSetup`, derives the SCA from the existing user
   * profile EOA. Returns the current row.
   */
  ensureUserSetup(userId: string): Promise<UserSetupRow>;

  /** Step 1 of chat flow — `place_bet:findingId:side` callback. */
  initiateBetIntent(input: InitiateBetIntentInput): Promise<InitiateBetIntentResult>;

  /** Step 2 — user replies with amount. */
  submitAmount(input: SubmitAmountInput): Promise<SubmitAmountResult>;

  /**
   * Step 3 — user taps Confirm; writes the executable bet row.
   *
   * Returns the new bet row and, when the first sign-request was enqueued
   * during this call, the `enqueuedRequestId` so the capability can emit
   * `${MINI_APP_URL}?requestId=<id>`. `null` when the bet is still waiting
   * on setup completion (setupAdvance kicks the first request later via
   * notifySetupSignResolved → kickPendingBetsForUser), or when the slot
   * was already locked by a prior advance().
   */
  confirmBetIntent(input: ConfirmBetIntentInput): Promise<{ bet: BetRow; enqueuedRequestId: string | null }>;

  /** Cancel intent before it executes. */
  cancelBetIntent(userId: string, intentId: string): Promise<void>;

  /**
   * Manually escape a stuck `executing` intent: marks the intent `cancelled`
   * and the orphaned bet `FAILED` with `failureReason='manual-cancel'`. No-op
   * if the intent is not in `executing` or doesn't belong to the user. Use
   * when the chat user reports the bet never completed (e.g. mini-app
   * deeplink was broken or the FE flow was interrupted).
   */
  cancelExecutingIntent(userId: string, intentId: string): Promise<void>;

  /** Read methods used by FE polling endpoints. */
  getBet(userId: string, betId: string): Promise<BetRow | null>;
  getBetIntent(userId: string, intentId: string): Promise<BetIntentRow | null>;
  getActiveIntent(userId: string): Promise<BetIntentRow | null>;
  listOpenPositions(userId: string): Promise<PositionRow[]>;

  /**
   * FE-facing variant of `listOpenPositions`: returns the same set of rows
   * (status in `'open'` or `'closing'`) but enriches each with the human
   * `marketQuestion` and binary `outcomeLabel` so the mini-app positions list
   * can render without doing a second join. Markets that have aged out of the
   * snapshots table fall back to a truncated id label and emit a warn log —
   * the position still renders so the user can close it.
   */
  listOpenPositionsForDisplay(userId: string): Promise<PositionListItem[]>;

  /**
   * FE has reported a terminal Polymarket outcome. Writes filled shares,
   * creates a `predictionMarketPositions` row on FILLED/PARTIAL for `open`
   * bets, transitions the parent position to `closed` (with realized PnL) for
   * `close` bets, transitions the chat intent to `completed` / `failed`.
   * Idempotent.
   */
  finalizeBet(
    input: FinalizeBetInput,
  ): Promise<{ bet: BetRow; position: PositionRow | null; closedPosition: PositionRow | null }>;

  /**
   * Build a confirm card payload for closing a position. Pulls live top-of-book
   * for the outcome token and computes PnL preview vs entry.
   */
  previewClose(
    userId: string,
    positionId: string,
  ): Promise<{
    position: PositionRow;
    bestBidPriceBps: number;
    estProceedsUsdcCents: number;
    estPnlUsdcCents: number;
  } | null>;

  /**
   * User confirmed the close: write a new `predictionMarketBets` row with
   * `betKind='close'`, mark the position `closing`, return the bet so the
   * mini-app deep-link can be emitted.
   */
  initiateClose(input: InitiateCloseInput): Promise<{ bet: BetRow; enqueuedRequestId: string | null }>;

  /**
   * Reconcile a single user's local positions against Polymarket's view.
   * Caller (poller) supplies the maker address + creds envelope from setup.
   */
  reconcileUserPositions(input: {
    userId: string;
    makerAddress: `0x${string}`;
    polymarketCredsEnc: string;
  }): Promise<ReconcileResult>;

  // ── Sign-queue driver ───────────────────────────────────────────────────

  /**
   * Idempotent driver. Reads the bet's current status and enqueues the next
   * sign request (or no-ops if the slot is already in-flight, or transitions
   * to FAILED on drift). Called from:
   *   - `notifySignResolved` after the previous step's /response landed,
   *   - the stuck-bet sweeper for bets whose mini-app went away mid-flow.
   * Safe to call repeatedly: each enqueue helper guards itself with a Redis
   * NX lock keyed on `(betId, slot)` so duplicate advances produce at most
   * one open sign request.
   */
  advance(betId: string): Promise<{ enqueuedRequestId: string | null }>;

  /**
   * Called by the /response handler after a sign-request resolved (approved
   * or rejected) for a row carrying `betId`. The use-case updates the bet
   * row to reflect the new artifact (tx hash / order id) and then calls
   * `advance` for the next slot.
   */
  notifySignResolved(input: {
    betId: string;
    requestId: string;
    kind: SigningRequestKind;
    purpose?: Eip712Purpose;
    txHash?: string;
    polymarketOrderId?: string;
    rejected: boolean;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void>;

  /**
   * Walks non-terminal bets older than `olderThanEpoch` and calls `advance`
   * on each. Used by `PredictionMarketStuckBetSweeperJob`. Returns the
   * number of bets the sweeper attempted to advance (observability only).
   */
  sweepStuckBets(olderThanEpoch: number): Promise<number>;

  /**
   * Drives the first-bet setup chain (Slice C). pending → sca_deployed is
   * BE-only; the three subsequent transitions enqueue sign requests
   * (gas-funding userop, three approval eoa_txs, one clob_auth eip712) and
   * advance on the matching /response resolution. Idempotent like
   * `advance`; safe to call from `start()` and from `notifySetupSignResolved`.
   */
  setupAdvance(userId: string): Promise<{ enqueuedRequestId: string | null }>;

  /**
   * /response fan-out target for setup-driven rows (setupForUserId set).
   * Mirrors `notifySignResolved` but acts on the setup state machine.
   */
  notifySetupSignResolved(input: {
    userId: string;
    requestId: string;
    kind: SigningRequestKind;
    purpose?: Eip712Purpose;
    txHash?: string;
    rejected: boolean;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void>;
}

