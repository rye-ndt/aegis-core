import type {
  DetectorSource,
  PaperBet,
  PaperBetInsert,
  PaperBetResolutionPatch,
  PaperBetStatus,
} from "./PaperBetTypes";

/** Sentinel bucket key used by `subject` aggregation for rows where subject is null. */
export const PAPER_BET_NULL_SUBJECT_BUCKET = "_unsubjected" as const;

export type PaperBetGroupBy = "overall" | "subject" | "clusterId" | "detectorSource";

export interface PerformanceBucket {
  /** "overall" | subject code | clusterId | detector source */
  key: string;
  betCount: number;
  totalStakeUsdcCents: number;
  totalPayoutUsdcCents: number;
  totalPnlUsdcCents: number;
  wins: number;
  losses: number;
  /** wins / (wins+losses) × 10_000. 0 when no resolved bets in bucket. */
  winRateBps: number;
  /** pnl / stake × 10_000. 0 when no stake in bucket. */
  roiBps: number;
  /** Postgres `percentile_cont(0.5)` over stake. 0 for empty buckets. */
  medianStakeUsdcCents: number;
  /** Postgres `percentile_cont(0.5)` over realized P&L. 0 for empty buckets. */
  medianPnlUsdcCents: number;
}

export interface AggregatePerformanceArgs {
  /** Omit for global aggregation. */
  userId?: string;
  groupBy: PaperBetGroupBy;
  /**
   * Defaults to `'resolved'` — realized ROI is the headline metric and open
   * bets contribute nothing meaningful until resolution. Pass an explicit
   * value to widen the slice (e.g. for an admin "all bets" view).
   */
  status?: PaperBetStatus;
  /**
   * Lower bound on `entry_at` (inclusive). The HTTP layer defaults this to
   * 30 days ago so a recent regression doesn't get hidden by stale wins.
   * Omit at the repo layer to disable the filter (return all-time).
   */
  since?: Date;
}

export interface IPredictionMarketPaperBetRepository {
  insert(row: PaperBetInsert): Promise<PaperBet>;
  findById(id: string): Promise<PaperBet | null>;

  /** Bets a user has placed, newest first. */
  listByUser(
    userId: string,
    opts?: { limit?: number; status?: PaperBetStatus },
  ): Promise<PaperBet[]>;

  /** Open bets across all users for a set of marketIds (resolution job batch fetch). */
  listOpenByMarkets(marketIds: string[]): Promise<PaperBet[]>;

  /** Distinct marketIds across all open bets — resolution job seed. */
  listOpenMarketIds(): Promise<string[]>;

  /**
   * Atomic batch settlement — wraps every per-row UPDATE in a single
   * transaction so a partial failure doesn't half-resolve a market's bets.
   * Returns the number of rows actually transitioned (skips rows that were
   * already non-open).
   */
  resolveMany(patches: PaperBetResolutionPatch[]): Promise<number>;

  /**
   * Aggregate performance metrics, sliced by `groupBy`. `winRateBps` and
   * `roiBps` are computed in JS post-query to dodge SQL DIV-by-zero on empty
   * buckets.
   */
  aggregatePerformance(args: AggregatePerformanceArgs): Promise<PerformanceBucket[]>;
}

export type { DetectorSource, PaperBet, PaperBetInsert, PaperBetResolutionPatch, PaperBetStatus };
