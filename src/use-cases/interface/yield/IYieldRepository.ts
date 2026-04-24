export interface YieldDeposit {
  id: string;
  userId: string;
  chainId: number;
  protocolId: string;
  tokenAddress: string;
  amountRaw: string;
  requestedPct: number;
  idleAtRequestRaw: string;
  txHash: string | null;
  userOpHash: string | null;
  status: string;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface NewYieldDeposit {
  userId: string;
  chainId: number;
  protocolId: string;
  tokenAddress: string;
  amountRaw: string;
  requestedPct: number;
  idleAtRequestRaw: string;
}

export interface YieldWithdrawal {
  id: string;
  userId: string;
  chainId: number;
  protocolId: string;
  tokenAddress: string;
  amountRaw: string;
  txHash: string | null;
  userOpHash: string | null;
  status: string;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface NewYieldWithdrawal {
  userId: string;
  chainId: number;
  protocolId: string;
  tokenAddress: string;
  amountRaw: string;
}

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
  recordDeposit(deposit: NewYieldDeposit): Promise<string>;
  updateDepositStatus(id: string, status: string, txHash?: string, userOpHash?: string): Promise<void>;
  recordWithdrawal(withdrawal: NewYieldWithdrawal): Promise<string>;
  updateWithdrawalStatus(id: string, status: string, txHash?: string, userOpHash?: string): Promise<void>;
  listPositions(userId: string): Promise<YieldDeposit[]>;
  listActiveProtocols(userId: string): Promise<Array<{ chainId: number; protocolId: string; tokenAddress: string }>>;
  listSnapshots(userId: string, sinceEpoch: number): Promise<YieldPositionSnapshot[]>;
  upsertSnapshot(snapshot: Omit<YieldPositionSnapshot, "id">): Promise<void>;
  getPrincipalRaw(userId: string, chainId: number, protocolId: string, tokenAddress: string): Promise<string>;
  listUsersWithPositions(): Promise<string[]>;
}
