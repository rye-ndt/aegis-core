export type ProviderBalance = {
  symbol: string;
  address: string;
  decimals: number;
  balance: string;
  rawBalance: string;
  usdValue: number | null;
  isNative: boolean;
};

export interface IBalanceProvider {
  /**
   * Return all non-zero balances (native + ERC20) for `address` on `chainId`.
   * Implementations MUST omit zero-balance entries.
   * Implementations MUST sort by usdValue desc when usdValue is available.
   */
  getBalances(chainId: number, address: `0x${string}`): Promise<ProviderBalance[]>;
}
