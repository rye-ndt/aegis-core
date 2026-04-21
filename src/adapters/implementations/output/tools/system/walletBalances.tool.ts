import { z } from "zod";
import { toErrorMessage } from "../../../../../helpers/errors/toErrorMessage";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../../use-cases/interface/output/tool.interface";
import type { IWalletDataProvider } from "../../../../../use-cases/interface/output/walletDataProvider.interface";
import type { IUserProfileCache } from "../../../../../use-cases/interface/output/cache/userProfile.cache";

export class WalletBalancesTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly walletDataProvider: IWalletDataProvider,
    private readonly userProfileCache: IUserProfileCache | undefined,
  ) {}

  definition(): IToolDefinition {
    return {
      name: "privy_wallet_balances",
      description:
        "Fetch the current wallet balances (native tokens and major stablecoins) across all chains " +
        "for the authenticated user. No input required.",
      inputSchema: z.toJSONSchema(z.object({})),
    };
  }

  async execute(_input: IToolInput): Promise<IToolOutput> {
    try {
      const profile = await this.userProfileCache?.get(this.userId).catch(() => null);
      if (!profile?.privyDid) {
        return { success: false, error: "USER_PROFILE_NOT_FOUND: cannot resolve wallet identity" };
      }
      const balances = await this.walletDataProvider.getBalances(profile.privyDid);
      return { success: true, data: balances };
    } catch (err) {
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
