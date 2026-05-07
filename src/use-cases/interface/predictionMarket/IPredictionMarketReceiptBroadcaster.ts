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
}
