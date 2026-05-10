import type {
  BetIntentRow,
  BetRow,
  BetStatus,
  PositionRow,
  SetupStep,
  UserSetupRow,
} from "./IPredictionMarketBetRepository";
import type { PolymarketCreds } from "./IPolymarketAdapter";

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
}

export interface SetupArtifact {
  bridgeIntentId?: string;
  approvalsTxHashes?: string[];
}
