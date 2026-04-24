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
import type { ITokenRegistryService } from "../../../../use-cases/interface/output/tokenRegistry.interface";
import type { ViemClientAdapter } from "../blockchain/viemClient";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("getPortfolioTool");

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const InputSchema = z.object({});

export class GetPortfolioTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly userProfileDB: IUserProfileDB,
    private readonly tokenRegistryService: ITokenRegistryService,
    private readonly viemClient: ViemClientAdapter,
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
        log.debug({ choice: cached ? "cache-hit" : "cache-miss", embedded: cached?.embeddedWalletAddress ?? "none" }, "Redis cache lookup");
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

      const scaAddress = walletAddress;
      log.debug({ step: "fetch-balances", walletLabel, address: scaAddress }, "fetching balances");
      const tokens = await this.tokenRegistryService.listByChain(this.chainId);
      log.debug({ tokenCount: tokens.length, chainId: this.chainId }, "token list loaded");

      const nativeTokens = tokens.filter((t) => t.isNative);
      const erc20Tokens = tokens.filter((t) => !t.isNative);

      const nativeBalances = await Promise.all(
        nativeTokens.map((t) =>
          this.viemClient.publicClient
            .getBalance({ address: scaAddress })
            .then((b) => ({ token: t, raw: b }))
            .catch(() => ({ token: t, raw: 0n })),
        ),
      );

      const erc20Results = erc20Tokens.length > 0
        ? await this.viemClient.publicClient.multicall({
            contracts: erc20Tokens.map((t) => ({
              address: t.address as `0x${string}`,
              abi: ERC20_BALANCE_ABI,
              functionName: "balanceOf" as const,
              args: [scaAddress] as [`0x${string}`],
            })),
            allowFailure: true,
          })
        : [];

      log.debug({ step: "multicall-done", erc20Count: erc20Results.length }, "multicall complete");

      const rows: string[] = [`${walletLabel}: ${scaAddress}`, "", "Token | Balance", "------|-------"];

      for (const { token, raw } of nativeBalances) {
        rows.push(`${token.symbol} | ${(Number(raw) / 10 ** token.decimals).toFixed(6)}`);
      }

      for (let i = 0; i < erc20Tokens.length; i++) {
        const token = erc20Tokens[i]!;
        const result = erc20Results[i];
        const raw = result?.status === "success" ? (result.result as bigint) : 0n;
        rows.push(`${token.symbol} | ${(Number(raw) / 10 ** token.decimals).toFixed(6)}`);
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
