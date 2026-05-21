import type { BetRow, PositionRow } from "./IPredictionMarketBetRepository";

/**
 * Pushes stage-4 receipt cards directly to the user's chat (no FE round-trip).
 * Called from finalizeBet outcomes and from the position poller on settlement.
 */
export interface IPredictionMarketReceiptBroadcaster {
  /**
   * Dispatch the appropriate card for a finalize outcome. Centralizes the
   * `betKind` + outcome branching so HTTP handlers stay dumb pass-throughs.
   */
  broadcastFinalizeOutcome(input: {
    userId: string;
    outcome: "FILLED" | "PARTIAL" | "UNFILLED" | "FAILED";
    bet: BetRow;
    position: PositionRow | null;
    closedPosition: PositionRow | null;
  }): Promise<void>;
  /** Pushed by the poller when a market resolves on Polymarket. */
  broadcastPositionResolved(input: { userId: string; position: PositionRow }): Promise<void>;
  /**
   * Pushed from `advance()` when a queue-driven bet fails the pre-sign drift
   * check (live mid moved beyond `maxOrderDriftBps` vs the recorded ref).
   * The legacy FE-driven path reported drift via `pmApi.driftDetected`; in the
   * one-click flow the mini-app has no UI to surface it, so the BE pushes a
   * chat card directly.
   */
  emitDriftCard(bet: BetRow): Promise<void>;
}
