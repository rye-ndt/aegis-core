export interface IFeeRecord {
  id: string;
  executionId: string;
  userId: string;
  totalFeeBps: number;
  platformFeeBps: number;
  contributorFeeBps: number;
  feeTokenAddress: string;
  feeAmountRaw: string;
  platformAddress: string;
  contributorAddress?: string | null;
  txHash: string;
  chainId: number;
  createdAtEpoch: number;
}

export interface FeeRecordInit {
  id: string;
  executionId: string;
  userId: string;
  totalFeeBps: number;
  platformFeeBps: number;
  contributorFeeBps: number;
  feeTokenAddress: string;
  feeAmountRaw: string;
  platformAddress: string;
  contributorAddress?: string | null;
  txHash: string;
  chainId: number;
  createdAtEpoch: number;
}

export interface IFeeRecordDB {
  create(record: FeeRecordInit): Promise<void>;
  findByExecutionId(executionId: string): Promise<IFeeRecord | undefined>;
}
