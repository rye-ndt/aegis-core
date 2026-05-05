export interface WalletTransactionStatus {
  id: string;
  status: "broadcasted" | "confirmed" | "failed" | "unknown";
  transactionHash?: string;
  chainId?: number;
}

export interface IWalletDataProvider {
  /** Fetch the lifecycle status of a specific transaction */
  getTransactionStatus(transactionId: string): Promise<WalletTransactionStatus | null>;
}
