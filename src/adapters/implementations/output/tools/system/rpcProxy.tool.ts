import { z } from "zod";
import { toErrorMessage } from "../../../../../helpers/errors/toErrorMessage";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../../use-cases/interface/output/tool.interface";
import type { IWalletDataProvider } from "../../../../../use-cases/interface/output/walletDataProvider.interface";
import type { IUserProfileCache } from "../../../../../use-cases/interface/output/cache/userProfile.cache";
import { CHAIN_CONFIG } from "../../../../../helpers/chainConfig";

const InputSchema = z.object({
  method: z.string().describe(
    "JSON-RPC method name, e.g. eth_call, eth_estimateGas, eth_getTransactionCount",
  ),
  network: z.string().describe(
    `Target network name (e.g. '${CHAIN_CONFIG.name.toLowerCase().replace(/ /g, "-")}', 'ethereum', 'base', 'polygon', 'arbitrum', 'optimism') ` +
    `or a raw CAIP-2 string such as 'eip155:${CHAIN_CONFIG.chainId}'.`,
  ),
  params: z.array(z.unknown()).describe("JSON-RPC params array appropriate to the method"),
});

export class RpcProxyTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly walletDataProvider: IWalletDataProvider,
    private readonly userProfileCache: IUserProfileCache | undefined,
  ) {}

  definition(): IToolDefinition {
    return {
      name: "privy_rpc_proxy",
      description:
        "Proxy a read-only JSON-RPC call (eth_call, eth_estimateGas, eth_getTransactionCount, " +
        "or custom contract reads) through the wallet provider for the current user. " +
        "Use this for on-chain data reads that require the user's wallet context.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const { method, network, params } = InputSchema.parse(input);
      const profile = await this.userProfileCache?.get(this.userId).catch(() => null);
      if (!profile?.privyDid) {
        return { success: false, error: "USER_PROFILE_NOT_FOUND: cannot resolve wallet identity" };
      }
      const result = await this.walletDataProvider.rpcCall(profile.privyDid, method, network, params);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
