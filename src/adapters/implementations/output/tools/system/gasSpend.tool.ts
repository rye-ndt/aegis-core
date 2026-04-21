import { z } from "zod";
import { toErrorMessage } from "../../../../../helpers/errors/toErrorMessage";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../../use-cases/interface/output/tool.interface";
import type { IWalletDataProvider } from "../../../../../use-cases/interface/output/walletDataProvider.interface";
import type { IUserProfileCache } from "../../../../../use-cases/interface/output/cache/userProfile.cache";

const InputSchema = z.object({
  start_date: z.string().optional().describe("Optional ISO date string for the start of the query window"),
});

export class GasSpendTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly walletDataProvider: IWalletDataProvider,
    private readonly userProfileCache: IUserProfileCache | undefined,
  ) {}

  definition(): IToolDefinition {
    return {
      name: "privy_gas_spend",
      description:
        "Get the total gas sponsorship (Paymaster) spend charged for the current user's smart account. " +
        "Returns the aggregate USD value of credits consumed. Optionally filter by start date.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const { start_date } = InputSchema.parse(input);
      const profile = await this.userProfileCache?.get(this.userId).catch(() => null);
      const userIds = profile?.privyDid ? [profile.privyDid] : undefined;
      const result = await this.walletDataProvider.getGasSpend(userIds, start_date);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
