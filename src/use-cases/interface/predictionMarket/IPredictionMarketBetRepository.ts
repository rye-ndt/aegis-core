/**
 * Persistence port for stage-4 prediction-market bet execution.
 *
 * Stays separate from `IPredictionMarketRepository` (read-only universe +
 * clusters + findings) so the broadcast pipeline can't accidentally pick up
 * a write surface for bets.
 */

export const SETUP_STEPS = [
  "pending",
  "sca_deployed",
  "gas_funded",
  "approved",
  "authed",
  "complete",
] as const;
export type SetupStep = typeof SETUP_STEPS[number];

export const BET_INTENT_STATUSES = [
  "awaiting_amount",
  "awaiting_confirm",
  "executing",
  "completed",
  "cancelled",
  "failed",
] as const;
export type BetIntentStatus = typeof BET_INTENT_STATUSES[number];

export const BET_STATUSES = [
  "INITIATED",
  "BRIDGING",
  "BRIDGED",
  "SCA_TO_EOA",
  "ORDER_SIGNED",
  "ORDER_SUBMITTED",
  "FILLED",
  "PARTIAL",
  "UNFILLED",
  "FAILED",
] as const;
export type BetStatus = typeof BET_STATUSES[number];

/** BetStatus values that the FE may transition through while executing. */
export const BET_TRANSITION_STATUSES = [
  "INITIATED",
  "BRIDGING",
  "BRIDGED",
  "SCA_TO_EOA",
  "ORDER_SIGNED",
  "ORDER_SUBMITTED",
] as const;
export type BetTransitionStatus = typeof BET_TRANSITION_STATUSES[number];

/** Terminal BetStatus values fed through `finalizeBet`, never `transitionBet`. */
export const BET_TERMINAL_STATUSES = ["FILLED", "PARTIAL", "UNFILLED", "FAILED"] as const;
export type BetTerminalStatus = typeof BET_TERMINAL_STATUSES[number];

/**
 * Legal forward transitions for the bet state machine. The repository rejects
 * any update that would move a bet to a status not in the source state's
 * allowed-set, so a buggy or replayed FE call can't skip a step (e.g. jump
 * `INITIATED → ORDER_SUBMITTED` and bypass the bridge).
 *
 * - Non-terminal states all allow `FAILED` so that errors flush the row out
 *   regardless of where the failure was observed.
 * - `FILLED`/`PARTIAL`/`UNFILLED` are terminal; once reached the bet is
 *   immutable.
 *
 * Setting a status equal to the current one is *not* in the map; callers
 * should use a no-op patch via `updateBetPatch` when they only need to write
 * an artifact field.
 */
export const BET_STATE_TRANSITIONS: Readonly<Record<BetStatus, readonly BetStatus[]>> = {
  // INITIATED → SCA_TO_EOA is the zero-sign skip-bridge path (2026-05-15):
  // advance() jumps straight to the SCA→EOA userop when USDC is already on
  // Polygon. Legacy bridge-driven path (INITIATED → BRIDGING → BRIDGED → SCA_TO_EOA)
  // is still legal so existing FE flows keep working until Slice F removes them.
  INITIATED:       ["BRIDGING", "SCA_TO_EOA", "FAILED"],
  BRIDGING:        ["BRIDGED", "FAILED"],
  BRIDGED:         ["SCA_TO_EOA", "FAILED"],
  // SCA_TO_EOA → ORDER_SUBMITTED is the zero-sign skip-intermediate path:
  // the order signature is verified at /response time, so ORDER_SIGNED is
  // never a useful intermediate state in the new flow. Keeping the legacy
  // SCA_TO_EOA → ORDER_SIGNED transition for the FE-driven path.
  SCA_TO_EOA:      ["ORDER_SIGNED", "ORDER_SUBMITTED", "FAILED"],
  ORDER_SIGNED:    ["ORDER_SUBMITTED", "FAILED"],
  ORDER_SUBMITTED: ["FILLED", "PARTIAL", "UNFILLED", "FAILED"],
  FILLED:          [],
  PARTIAL:         [],
  UNFILLED:        [],
  FAILED:          [],
} as const;

export class IllegalBetTransitionError extends Error {
  constructor(public readonly from: BetStatus, public readonly to: BetStatus) {
    super(`Illegal bet transition: ${from} → ${to}`);
    this.name = "IllegalBetTransitionError";
  }
}

export const POSITION_STATUSES = ["open", "closing", "closed", "resolved"] as const;
export type PositionStatus = typeof POSITION_STATUSES[number];

export interface UserSetupRow {
  userId: string;
  polygonScaAddress: string;
  polygonEoaAddress: string;
  bootstrapBridgeIntentId: string | null;
  approvalsTxHashes: string[] | null;
  /** AES-GCM envelope; never decrypt outside the polymarket adapter. */
  polymarketCredsEnc: string | null;
  setupStep: SetupStep;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface BetIntentRow {
  id: string;
  userId: string;
  findingId: string | null;
  marketId: string;
  side: string;
  outcomeTokenId: string | null;
  /** Stake in USDC cents. Null until the amount step. */
  stakeUsdcCents: number | null;
  refPriceBps: number | null;
  status: BetIntentStatus;
  betId: string | null;
  expiresAtEpoch: number;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface BetRow {
  id: string;
  userId: string;
  intentId: string | null;
  findingId: string | null;
  marketId: string;
  outcomeTokenId: string | null;
  side: string;
  stakeUsdcCents: number;
  refPriceBps: number | null;
  clientOrderId: string;
  bridgeIntentId: string | null;
  scaToEoaTxHash: string | null;
  polymarketOrderId: string | null;
  status: BetStatus;
  filledShares: string | null;
  filledAvgPriceBps: number | null;
  failureReason: string | null;
  betKind: "open" | "close";
  parentBetId: string | null;
  /**
   * True when stake was transferred to the EOA (`scaToEoaTxHash` set) but the
   * bet did not fully fill on Polymarket. The mini-app reads this on its next
   * open and submits a paymaster-sponsored refund UserOp moving the residual
   * USDC EOA → Polygon SCA. Cleared by `setBetRefundTxHash`.
   */
  refundRequired: boolean;
  refundTxHash: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface PositionRow {
  id: string;
  userId: string;
  marketId: string;
  outcomeTokenId: string;
  side: string;
  sizeShares: string;
  entryPriceAvgBps: number;
  entryStakeUsdcCents: number;
  openingBetId: string | null;
  closingBetId: string | null;
  currentValueUsdcCents: number | null;
  status: PositionStatus;
  resolvedOutcome: string | null;
  realizedPnlUsdcCents: number | null;
  openedAtEpoch: number;
  closedAtEpoch: number | null;
}

export interface InsertBetIntentInput {
  id: string;
  userId: string;
  findingId: string | null;
  marketId: string;
  side: string;
  outcomeTokenId: string | null;
  refPriceBps: number | null;
  expiresAtEpoch: number;
}

export interface InsertBetInput {
  id: string;
  userId: string;
  intentId: string | null;
  findingId: string | null;
  marketId: string;
  outcomeTokenId: string | null;
  side: string;
  stakeUsdcCents: number;
  refPriceBps: number | null;
  clientOrderId: string;
  betKind: "open" | "close";
  parentBetId: string | null;
}

export interface IPredictionMarketBetRepository {
  // ── User setup ────────────────────────────────────────────────────────
  upsertUserSetup(row: UserSetupRow): Promise<void>;
  getUserSetup(userId: string): Promise<UserSetupRow | null>;
  updateSetupStep(userId: string, step: SetupStep): Promise<void>;
  setBootstrapBridgeIntentId(userId: string, intentId: string): Promise<void>;
  setApprovalsTxHashes(userId: string, hashes: string[]): Promise<void>;
  setPolymarketCredsEnc(userId: string, envelope: string): Promise<void>;

  // ── Bet intents (chat-side) ───────────────────────────────────────────
  insertBetIntent(input: InsertBetIntentInput): Promise<BetIntentRow>;
  getBetIntent(id: string): Promise<BetIntentRow | null>;
  setBetIntentAmount(id: string, stakeUsdcCents: number): Promise<void>;
  setBetIntentStatus(id: string, status: BetIntentStatus, betId?: string): Promise<void>;
  findActiveIntentForUser(userId: string): Promise<BetIntentRow | null>;

  // ── Bets (execution) ──────────────────────────────────────────────────
  insertBet(input: InsertBetInput): Promise<BetRow>;
  getBet(id: string): Promise<BetRow | null>;
  /**
   * Updates `status` to `next` after verifying the move is in
   * `BET_STATE_TRANSITIONS[current]`. Throws `IllegalBetTransitionError`
   * otherwise so the caller can map to a 409 — never silently drops illegal
   * moves (which would mask FE state-machine drift).
   */
  updateBetStatus(id: string, next: BetStatus, patch?: Partial<BetRow>): Promise<void>;
  setBetFailure(id: string, reason: string): Promise<void>;
  /** Set the residual-funds refund flag on a non-fully-filled terminal bet. */
  setBetRefundRequired(id: string, required: boolean): Promise<void>;
  /** Record the on-chain hash of the EOA→SCA refund UserOp. */
  setBetRefundTxHash(id: string, txHash: string): Promise<void>;
  /**
   * Number of bets for the user whose status is not in {FILLED, UNFILLED,
   * FAILED}. PARTIAL counts as in-flight until refund is recorded — the
   * use-case calls `countOpenBetsForUser` *before* `confirmBetIntent` to
   * reject concurrent confirms.
   */
  countOpenBetsForUser(userId: string): Promise<number>;

  // Newest non-terminal bet for `userId`, or null. Used by setup-completion
  // to kick the bet that was waiting on setup. Matches the per-user one-bet
  // invariant enforced by countOpenBetsForUser at confirm time.
  findActiveBetForUser(userId: string): Promise<BetRow | null>;

  // Non-terminal bets (status not in {FILLED, UNFILLED, FAILED}) plus PARTIAL
  // bets whose refund is outstanding, whose `updatedAtEpoch` is older than
  // `olderThanEpoch`. The stuck-bet sweeper drives this list through
  // `advance()` so mini-apps that went away mid-flow get re-enqueued.
  // Capped by `limit` to keep a single sweep tick bounded.
  listStuckBets(olderThanEpoch: number, limit: number): Promise<BetRow[]>;

  // ── Positions ─────────────────────────────────────────────────────────
  insertPosition(row: PositionRow): Promise<void>;
  listOpenPositionsForUser(userId: string): Promise<PositionRow[]>;
  getPosition(id: string): Promise<PositionRow | null>;
  updatePositionStatus(id: string, status: PositionStatus, patch?: Partial<PositionRow>): Promise<void>;
  /** Decrement a position's `sizeShares` by `delta` (decimal-string subtract). */
  decrementPositionShares(id: string, delta: string): Promise<void>;
  /** Resolve the position created by a specific bet (open or close). */
  findPositionByOpeningBetId(betId: string): Promise<PositionRow | null>;
  findPositionByClosingBetId(betId: string): Promise<PositionRow | null>;
  /**
   * Users that own at least one position with status open/closing, joined to
   * their setup row so the poller doesn't N+1-fetch creds per user.
   * `polymarketCredsEnc` is null for users still mid-setup; the poller skips
   * those rather than treating it as an error.
   */
  listUsersWithOpenPositions(): Promise<
    Array<{
      userId: string;
      polygonEoaAddress: string;
      polymarketCredsEnc: string | null;
    }>
  >;
}
