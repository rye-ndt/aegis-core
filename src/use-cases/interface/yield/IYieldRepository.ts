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
  upsertSnapshot(snapshot: Omit<YieldPositionSnapshot, "id">): Promise<void>;
  /** Returns distinct userIds that have a snapshot more recent than sinceEpoch. */
  listUsersWithRecentSnapshots(sinceEpoch: number): Promise<string[]>;
}
