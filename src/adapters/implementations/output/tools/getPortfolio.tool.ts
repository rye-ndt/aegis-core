import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { ITokenRegistryService } from "../../../../use-cases/interface/output/tokenRegistry.interface";
import type { ViemClientAdapter } from "../blockchain/viemClient";

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
      const profile = await this.userProfileDB.findByUserId(this.userId);
      if (!profile?.smartAccountAddress) {
        return {
          success: false,
          error: "No Smart Contract Account found. Please complete registration first.",
        };
      }

      const scaAddress = profile.smartAccountAddress as `0x${string}`;
      const tokens = await this.tokenRegistryService.listByChain(this.chainId);

      const rows: string[] = ["Token | Balance", "------|-------"];

      for (const token of tokens) {
        let rawBalance: bigint;
        if (token.isNative) {
          rawBalance = await this.viemClient.publicClient.getBalance({ address: scaAddress });
        } else {
          rawBalance = await this.viemClient.publicClient.readContract({
            address: token.address as `0x${string}`,
            abi: ERC20_BALANCE_ABI,
            functionName: "balanceOf",
            args: [scaAddress],
          }) as bigint;
        }

        const humanBalance = (Number(rawBalance) / 10 ** token.decimals).toFixed(6);
        rows.push(`${token.symbol} | ${humanBalance}`);
      }

      return { success: true, data: rows.join("\n") };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }
}
