import type {
  BetIntentRow,
  BetRow,
  BetStatus,
  PositionRow,
  SetupStep,
  UserSetupRow,
} from "./IPredictionMarketBetRepository";
import type { PolymarketCreds } from "./IPolymarketAdapter";
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

  /** Persist a setup-state transition driven by the FE mini-app. */
  recordSetupStep(userId: string, step: SetupStep, artifact?: SetupArtifact): Promise<UserSetupRow>;

  /**
   * AES-encrypts the L2 creds returned from `polymarket.deriveApiKey` and
   * stores them under `polymarket_creds_enc`. Atomic with `setupStep=authed`.
   */
  storePolymarketCreds(userId: string, creds: PolymarketCreds): Promise<void>;

  /** Step 1 of chat flow — `place_bet:findingId:side` callback. */
  initiateBetIntent(input: InitiateBetIntentInput): Promise<InitiateBetIntentResult>;

  /** Step 2 — user replies with amount. */
  submitAmount(input: SubmitAmountInput): Promise<SubmitAmountResult>;

  /** Step 3 — user taps Confirm; writes the executable bet row. */
  confirmBetIntent(input: ConfirmBetIntentInput): Promise<BetRow>;

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

  /**
   * Generic FE-driven state transition during execution. Caller validates the
   * bet belongs to the user (via `getBet`) before calling. Logs the transition
   * with `step` matching the new status (e.g. `bridge-submitted`, `sca-to-eoa`).
   */
  transitionBet(
    userId: string,
    betId: string,
    status: BetStatus,
    patch?: { bridgeIntentId?: string; scaToEoaTxHash?: string; polymarketOrderId?: string },
  ): Promise<BetRow>;

  /** Read methods used by FE polling endpoints. */
  getBet(userId: string, betId: string): Promise<BetRow | null>;
  getBetIntent(userId: string, intentId: string): Promise<BetIntentRow | null>;
  getActiveIntent(userId: string): Promise<BetIntentRow | null>;
  listOpenPositions(userId: string): Promise<PositionRow[]>;

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
  initiateClose(input: InitiateCloseInput): Promise<BetRow>;

  /**
   * Reconcile a single user's local positions against Polymarket's view.
   * Caller (poller) supplies the maker address + creds envelope from setup.
   */
  reconcileUserPositions(input: {
    userId: string;
    makerAddress: `0x${string}`;
    polymarketCredsEnc: string;
  }): Promise<ReconcileResult>;

  /**
   * FE-reported drift between the live top-of-book and the bet's recorded
   * `refPriceBps`. Returns an `ok` decision when within tolerance (FE may
   * proceed to sign), or `reconfirm` with an updated reference price when the
   * caller should re-prompt the user in chat.
   */
  reportPriceDrift(input: {
    userId: string;
    betId: string;
    livePriceBps: number;
  }): Promise<
    | { decision: "ok" }
    | { decision: "reconfirm"; previousRefPriceBps: number; newRefPriceBps: number; driftBps: number }
  >;

  /**
   * Records the on-chain hash of the residual-funds refund UserOp the
   * mini-app submitted (EOA → user's Polygon SCA). Clears `refundRequired` on
   * success so the FE state-machine doesn't loop.
   */
  recordRefundTxHash(userId: string, betId: string, txHash: string): Promise<BetRow>;

  // ── 2026-05-15 zero-sign bet rewrite (Slice B) ────────────────────────────
  // Methods below are dormant unless PREDICTION_MARKETS_USE_SIGN_QUEUE=true,
  // and even then only fire when a sign-request resolves with a `betId` set
  // (Slice D is what writes such rows). Existing FE flows are untouched.

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
  advance(betId: string): Promise<void>;

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
  setupAdvance(userId: string): Promise<void>;

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

export interface SetupArtifact {
  bridgeIntentId?: string;
  approvalsTxHashes?: string[];
}
