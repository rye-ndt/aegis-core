import type { ITokenRecord } from '../output/repository/tokenRegistry.repo';

export type { ITokenRecord };

export type PortfolioBalance = { symbol: string; address: string; decimals: number; balance: string };
export type PortfolioResult = { smartAccountAddress: string; balances: PortfolioBalance[] };
export type WalletInfo = {
  smartAccountAddress: string | null;
  sessionKeyAddress: string | null;
  sessionKeyStatus: string | null;
  sessionKeyExpiresAtEpoch: number | null;
};

export interface IPortfolioUseCase {
  getPortfolio(userId: string): Promise<PortfolioResult | null>;
  getWalletInfo(userId: string): Promise<WalletInfo | null>;
  listTokens(chainId: number): Promise<ITokenRecord[]>;
}
