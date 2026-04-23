import type { IPortfolioUseCase, PortfolioResult, WalletInfo } from '../interface/input/portfolio.interface';
import type { ITokenRecord } from '../interface/output/repository/tokenRegistry.repo';
import type { IUserProfileDB } from '../interface/output/repository/userProfile.repo';
import type { ITokenRegistryService } from '../interface/output/tokenRegistry.interface';
import type { IChainReader } from '../interface/output/blockchain/chainReader.interface';

export class PortfolioUseCaseImpl implements IPortfolioUseCase {
  constructor(
    private readonly userProfileDB: IUserProfileDB,
    private readonly tokenRegistryService: ITokenRegistryService,
    private readonly chainReader: IChainReader,
    private readonly chainId: number,
  ) {}

  async getPortfolio(userId: string): Promise<PortfolioResult | null> {
    const profile = await this.userProfileDB.findByUserId(userId);
    if (!profile?.smartAccountAddress) return null;

    const scaAddress = profile.smartAccountAddress as `0x${string}`;
    const tokens = await this.tokenRegistryService.listByChain(this.chainId);

    const balances = await Promise.all(
      tokens.map(async (token) => {
        const rawBalance = await (token.isNative
          ? this.chainReader.getNativeBalance(scaAddress)
          : this.chainReader.getErc20Balance(token.address as `0x${string}`, scaAddress)
        ).catch(() => 0n);
        return {
          symbol: token.symbol,
          address: token.address,
          decimals: token.decimals,
          balance: (Number(rawBalance) / 10 ** token.decimals).toFixed(6),
        };
      }),
    );

    return { smartAccountAddress: profile.smartAccountAddress, balances };
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
