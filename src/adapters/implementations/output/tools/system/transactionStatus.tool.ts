import { z } from "zod";
import { toErrorMessage } from "../../../../../helpers/errors/toErrorMessage";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../../use-cases/interface/output/tool.interface";
import type { IWalletDataProvider } from "../../../../../use-cases/interface/output/walletDataProvider.interface";

const InputSchema = z.object({
  transaction_id: z.string().describe("The Privy transaction ID to look up"),
});

export class TransactionStatusTool implements ITool {
  constructor(private readonly walletDataProvider: IWalletDataProvider) {}

  definition(): IToolDefinition {
    return {
      name: "privy_transaction_status",
      description:
        "Check the status of a transaction managed by Privy. Returns whether the transaction " +
        "has been broadcasted, confirmed, or failed, along with the on-chain hash.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const { transaction_id } = InputSchema.parse(input);
      const status = await this.walletDataProvider.getTransactionStatus(transaction_id);
      if (!status) return { success: false, error: "TRANSACTION_NOT_FOUND" };
      return { success: true, data: status };
    } catch (err) {
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
