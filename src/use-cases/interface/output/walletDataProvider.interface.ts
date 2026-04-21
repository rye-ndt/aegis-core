export interface WalletBalance {
  chainId: number;
  tokenSymbol: string;
  tokenAddress: string | null; // null for native token
  decimals: number;
  rawAmount: string;          // wei / smallest unit, as string
  usdDisplay: string;         // human-readable USD string e.g. "$12.34"
}

export interface WalletTransactionStatus {
  id: string;
  status: "broadcasted" | "confirmed" | "failed" | "unknown";
  transactionHash?: string;
  chainId?: number;
}

export interface GasSpendResult {
  totalUsd: number;
  currency: string;            // "USD"
}

export interface IWalletDataProvider {
  /** Fetch all balances for the wallet identified by userIdentifier */
  getBalances(userIdentifier: string): Promise<WalletBalance[]>;

  /** Fetch the lifecycle status of a specific transaction */
  getTransactionStatus(transactionId: string): Promise<WalletTransactionStatus | null>;

  /** Fetch aggregate gas sponsorship spend. userIdentifiers filters by wallet (optional) */
  getGasSpend(userIdentifiers?: string[], startDate?: string): Promise<GasSpendResult>;

  /**
   * Proxy a JSON-RPC call through the wallet provider.
   * network: a canonical chain string, e.g. "avalanche", "ethereum", "base"
   * The implementation maps this to its own chain ID format (e.g. CAIP-2 for Privy).
   */
  rpcCall(
    userIdentifier: string,
    method: string,
    network: string,
    params: unknown[],
  ): Promise<unknown>;
}
