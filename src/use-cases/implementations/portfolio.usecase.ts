import { createLogger } from '../../helpers/observability/logger';
import type { IPortfolioUseCase, PortfolioResult, WalletInfo } from '../interface/input/portfolio.interface';
import type { ITokenRecord } from '../interface/output/repository/tokenRegistry.repo';
import type { IUserProfileDB } from '../interface/output/repository/userProfile.repo';
import type { ITokenRegistryService } from '../interface/output/tokenRegistry.interface';
import type { IBalanceProvider } from '../interface/output/blockchain/balanceProvider.interface';

const log = createLogger("portfolioUseCase");

export class PortfolioUseCaseImpl implements IPortfolioUseCase {
  constructor(
    private readonly userProfileDB: IUserProfileDB,
    private readonly tokenRegistryService: ITokenRegistryService,
    private readonly balanceProvider: IBalanceProvider,
    private readonly fallbackProvider: IBalanceProvider,
    private readonly chainId: number,
  ) {}

  async getPortfolio(userId: string): Promise<PortfolioResult | null> {
    const profile = await this.userProfileDB.findByUserId(userId);
    if (!profile?.smartAccountAddress) return null;

    const sca = profile.smartAccountAddress as `0x${string}`;

    let balances;
    try {
      balances = await this.balanceProvider.getBalances(this.chainId, sca);
    } catch (err) {
      log.warn({ err, chainId: this.chainId, step: "fallback" }, "primary-provider-failed");
      balances = await this.fallbackProvider.getBalances(this.chainId, sca);
    }

    return {
      smartAccountAddress: profile.smartAccountAddress,
      balances: balances.map((b) => ({
        symbol: b.symbol,
        address: b.address,
        decimals: b.decimals,
        balance: b.balance,
        usdValue: b.usdValue,
      })),
    };
  }

  async getWalletInfo(userId: string): Promise<WalletInfo | null> {
    const profile = await this.userProfileDB.findByUserId(userId);
    if (!profile) return null;
    return {
      smartAccountAddress: profile.smartAccountAddress ?? null,
      sessionKeyAddress: profile.sessionKeyAddress ?? null,
      sessionKeyStatus: profile.sessionKeyStatus ?? null,
      sessionKeyExpiresAtEpoch: profile.sessionKeyExpiresAtEpoch ?? null,
    };
  }

  async listTokens(chainId: number): Promise<ITokenRecord[]> {
    return this.tokenRegistryService.listByChain(chainId);
  }
}
