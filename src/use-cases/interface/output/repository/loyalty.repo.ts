import type { SeasonConfig } from "../../../../helpers/loyalty/pointsFormula";

export interface LoyaltySeason {
  id: string;
  name: string;
  startsAtEpoch: number;
  endsAtEpoch: number;
  status: string;
  formulaVersion: string;
  config: SeasonConfig;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface LoyaltyActionType {
  id: string;
  displayName: string;
  defaultBase: bigint;
  isActive: boolean;
  createdAtEpoch: number;
}

export interface LedgerEntry {
  id: string;
  userId: string;
  seasonId: string;
  actionType: string;
  pointsRaw: bigint;
  intentExecutionId: string | null;
  externalRef: string | null;
  formulaVersion: string;
  computedFromJson: object;
  metadataJson: object | null;
  createdAtEpoch: number;
}

export interface NewLedgerEntry {
  userId: string;
  seasonId: string;
  actionType: string;
  pointsRaw: bigint;
  intentExecutionId: string | null;
  externalRef: string | null;
  formulaVersion: string;
  computedFromJson: object;
  metadataJson: object | null;
}

export interface ILoyaltyRepository {
  getActiveSeason(): Promise<LoyaltySeason | null>;
  getActionType(id: string): Promise<LoyaltyActionType | null>;
  getUserLoyaltyStatus(userId: string): Promise<string | null>;
  getSumPointsToday(userId: string, seasonId: string, todayStartEpoch: number): Promise<bigint>;
  insertLedgerEntry(entry: NewLedgerEntry): Promise<LedgerEntry>;
  findByIntentExecutionId(intentExecutionId: string): Promise<LedgerEntry | null>;
  getUserBalance(userId: string, seasonId: string): Promise<bigint>;
  getUserRank(userId: string, seasonId: string): Promise<number | null>;
  getLeaderboard(seasonId: string, limit: number): Promise<{ userId: string; pointsTotal: bigint; rank: number }[]>;
  getHistory(userId: string, seasonId: string, limit: number, cursorCreatedAtEpoch?: number): Promise<LedgerEntry[]>;
}
