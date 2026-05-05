export type TransferDirection = "in" | "out" | "self";

export type TransferRecord = {
  chainId: number;
  txHash: `0x${string}`;
  logIndex: number | null;
  blockNumber: number;
  timestampEpoch: number;
  direction: TransferDirection;
  from: `0x${string}`;
  to: `0x${string}`;
  tokenAddress: `0x${string}`;
  tokenSymbol: string;
  tokenDecimals: number;
  isNative: boolean;
  amountRaw: string;
  amountFormatted: string;
  usdValue: number | null;
};

export type TransferHistoryQuery = {
  chainId: number;
  address: `0x${string}`;
  fromEpoch?: number;
  toEpoch?: number;
  direction?: TransferDirection;
  limit: number;
  cursor?: string;
};

export type TransferHistoryPage = {
  items: TransferRecord[];
  nextCursor: string | null;
};

export interface ITransferHistoryProvider {
  getHistory(q: TransferHistoryQuery): Promise<TransferHistoryPage>;
}
