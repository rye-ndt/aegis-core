import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import { toErrorMessage } from "../../../../helpers/errors/toErrorMessage";
import { CHAIN_CONFIG } from "../../../../helpers/chainConfig";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { IIntentUseCase } from "../../../../use-cases/interface/input/intent.interface";
import { newUuid } from "../../../../helpers/uuid";

const InputSchema = z.object({
  rawInput: z.string().min(1).describe(
    `The user's raw trading intent message. E.g. 'Swap 100 USDC for ${CHAIN_CONFIG.nativeSymbol}' or 'Claim my rewards'.`,
  ),
});

export class ExecuteIntentTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly conversationId: string,
    private readonly intentUseCase: IIntentUseCase,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.EXECUTE_INTENT,
      description:
        "Parse and execute an on-chain trading intent for the user. Call this when the user " +
        "wants to swap tokens, stake, unstake, claim rewards, or transfer assets. " +
        "Pass the user's message verbatim as rawInput.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const { rawInput } = InputSchema.parse(input);
    try {
      const result = await this.intentUseCase.parseAndExecute({
        userId: this.userId,
        conversationId: this.conversationId,
        messageId: newUuid(),
        rawInput,
      });
      return { success: true, data: result.humanSummary };
    } catch (err) {
      const message = toErrorMessage(err);
      return { success: false, error: message };
    }
  }
}
