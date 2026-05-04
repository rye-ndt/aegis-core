export interface YieldPositionSnapshot {
  id: string;
  userId: string;
  chainId: number;
  protocolId: string;
  tokenAddress: string;
  snapshotDateUtc: string;
  balanceRaw: string;
  principalRaw: string;
  snapshotAtEpoch: number;
}

export interface IYieldRepository {
  listSnapshots(userId: string, sinceEpoch: number): Promise<YieldPositionSnapshot[]>;
  /**
   * Snapshots whose `snapshotAtEpoch` falls in `[fromEpochInclusive, toEpochExclusive)`.
   * Used by daily-report and positions-view code that needs an exact UTC-day window
   * and cannot tolerate today's snapshot leaking into the yesterday delta calc.
   */
  listSnapshotsBetween(
    userId: string,
    fromEpochInclusive: number,
    toEpochExclusive: number,
  ): Promise<YieldPositionSnapshot[]>;
  upsertSnapshot(snapshot: Omit<YieldPositionSnapshot, "id">): Promise<void>;
  /** Returns distinct userIds that have a snapshot more recent than sinceEpoch. */
  listUsersWithRecentSnapshots(sinceEpoch: number): Promise<string[]>;
}
