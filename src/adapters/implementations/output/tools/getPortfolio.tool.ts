import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import { toErrorMessage } from "../../../../helpers/errors/toErrorMessage";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { IUserProfileCache } from "../../../../use-cases/interface/output/cache/userProfile.cache";
import type { IBalanceProvider } from "../../../../use-cases/interface/output/blockchain/balanceProvider.interface";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("getPortfolioTool");

const InputSchema = z.object({});

export class GetPortfolioTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly userProfileDB: IUserProfileDB,
    private readonly balanceProvider: IBalanceProvider,
    private readonly fallbackProvider: IBalanceProvider,
    private readonly chainId: number,
    private readonly userProfileCache?: IUserProfileCache,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.GET_PORTFOLIO,
      description:
        "Get the on-chain token balances for the user's Smart Contract Account. " +
        "Returns a table of token balances. No input parameters required.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(_input: IToolInput): Promise<IToolOutput> {
    try {
      log.debug({ step: "start", userId: this.userId }, "portfolio fetch started");
      const profile = await this.userProfileDB.findByUserId(this.userId);
      log.debug({ found: !!profile, sca: profile?.smartAccountAddress ?? "none" }, "db profile loaded");

      let walletAddress: `0x${string}` | undefined;
      let walletLabel = "Smart Contract Account";

      if (profile?.smartAccountAddress) {
        walletAddress = profile.smartAccountAddress as `0x${string}`;
      } else {
        const cached = await this.userProfileCache?.get(this.userId).catch(() => null);
        log.debug(
          { choice: cached ? "cache-hit" : "cache-miss", embedded: cached?.embeddedWalletAddress ?? "none" },
          "Redis cache lookup",
        );
        if (cached?.embeddedWalletAddress) {
          walletAddress = cached.embeddedWalletAddress as `0x${string}`;
          walletLabel = "Embedded Wallet (SCA not yet deployed)";
        }
      }

      if (!walletAddress) {
        return {
          success: false,
          error: "No wallet found. Please complete registration to deploy your Smart Contract Account.",
        };
      }

      log.debug({ step: "fetch-balances", walletLabel, address: `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` }, "fetching balances");

      let balances;
      try {
        balances = await this.balanceProvider.getBalances(this.chainId, walletAddress);
      } catch (err) {
        log.warn({ err, chainId: this.chainId, step: "fallback" }, "primary-provider-failed");
        balances = await this.fallbackProvider.getBalances(this.chainId, walletAddress);
      }

      const rows: string[] = [`${walletLabel}: ${walletAddress}`, "", "Token | Balance | USD", "------|-------|----"];

      for (const b of balances) {
        const usdStr = b.usdValue != null ? `$${b.usdValue.toFixed(2)}` : "—";
        rows.push(`${b.symbol} | ${b.balance} | ${usdStr}`);
      }

      log.info({ step: "done", rowCount: rows.length }, "portfolio fetch complete");
      return { success: true, data: rows.join("\n") };
    } catch (err) {
      log.error({ err }, "portfolio fetch error");
      const message = toErrorMessage(err);
      return { success: false, error: message };
    }
  }
}
