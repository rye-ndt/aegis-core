import { z } from "zod";
import { ExecuteIntentTool } from "../executeIntent.tool";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../../use-cases/interface/output/tool.interface";
import type { IIntentUseCase } from "../../../../../use-cases/interface/input/intent.interface";
import { CHAIN_CONFIG } from "../../../../../helpers/chainConfig";

const InputSchema = z.object({
  recipient: z.string().describe("Recipient wallet address (0x…)"),
  tokenAddress: z.string().describe("ERC-20 token contract address (0x…)"),
  amount: z.string().describe("Human-readable amount to transfer, e.g. '10.5'"),
  network: z.string().optional().describe(`Target network name, e.g. '${CHAIN_CONFIG.name.toLowerCase().replace(/ /g, "-")}', 'base'. Defaults to the configured chain.`),
});

export class TransferErc20Tool implements ITool {
  private readonly delegate: ExecuteIntentTool;

  constructor(userId: string, conversationId: string, intentUseCase: IIntentUseCase) {
    this.delegate = new ExecuteIntentTool(userId, conversationId, intentUseCase);
  }

  definition(): IToolDefinition {
    return {
      name: "transfer_erc20",
      description:
        "Transfer an ERC-20 token from the user's wallet to a recipient address. " +
        "Provide the exact token contract address, recipient, and amount. " +
        "Use this for token sends — not for swaps or staking.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    // Build a natural-language intent string and delegate to ExecuteIntentTool
    const parsed = InputSchema.safeParse(input);
    const rawInput = parsed.success
      ? `Transfer ${parsed.data.amount} of token ${parsed.data.tokenAddress} to ${parsed.data.recipient}${parsed.data.network ? ` on ${parsed.data.network}` : ""}`
      : JSON.stringify(input); // fallback: let intent parser figure it out

    return this.delegate.execute({ rawInput });
  }
}
