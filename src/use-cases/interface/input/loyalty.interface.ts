import type { LedgerEntry } from "../output/repository/loyalty.repo";

export interface AwardPointsInput {
  userId: string;
  actionType: string;
  usdValue?: number;
  userMultiplier?: number;
  intentExecutionId?: string;
  externalRef?: string;
  metadataJson?: object;
}

export interface AdjustInput {
  userId: string;
  seasonId: string;
  actionType: string;
  pointsRaw: bigint;
  externalRef?: string;
  metadataJson?: object;
}

export interface BalanceView {
  seasonId: string;
  pointsTotal: bigint;
  rank: number | null;
}

export interface LeaderboardView {
  seasonId: string;
  entries: { userId: string; pointsTotal: bigint; rank: number }[];
}

export interface ILoyaltyUseCase {
  awardPoints(input: AwardPointsInput): Promise<LedgerEntry | null>;
  getActiveSeasonId(): Promise<string | null>;
  getBalance(userId: string, seasonId?: string): Promise<BalanceView>;
  getHistory(userId: string, opts: {
    seasonId?: string;
    limit: number;
    cursorCreatedAtEpoch?: number;
  }): Promise<LedgerEntry[]>;
  getLeaderboard(seasonId: string, limit: number): Promise<LeaderboardView>;
  adjustPoints(input: AdjustInput): Promise<LedgerEntry>;
}
