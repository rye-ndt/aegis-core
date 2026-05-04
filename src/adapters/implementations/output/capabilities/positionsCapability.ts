import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";

const log = createLogger("positionsCapability");

const SEED_PROMPT =
  "Summarize the user's open Aster stock positions in a friendly paragraph, " +
  "then include the raw position table. Call get_stock_positions to fetch " +
  "the data. If there are no positions, say so plainly.";

interface PositionsParams {
  message: string;
}

/**
 * `/positions` — thin chat-seeded entry that delegates to the assistant LLM
 * loop. The agent calls `get_stock_positions` (registered as a system tool)
 * and renders its output. Kept as a dedicated capability rather than baking
 * the seed into AssistantChatCapability so the trigger remains explicit and
 * doesn't pollute the default free-text path.
 */
export class PositionsCapability implements Capability<PositionsParams> {
  readonly id = "intent_positions";
  readonly triggers: TriggerSpec = {
    commands: [INTENT_COMMAND.POSITIONS],
  };

  constructor(private readonly assistantUseCase: IAssistantUseCase) {}

  async collect(_ctx: CapabilityCtx): Promise<CollectResult<PositionsParams>> {
    return { kind: "ok", params: { message: SEED_PROMPT } };
  }

  async run(params: PositionsParams, ctx: CapabilityCtx): Promise<Artifact> {
    log.info({ step: "started", userId: ctx.userId }, "positions chat started");
    try {
      const response = await this.assistantUseCase.chat({
        userId: ctx.userId,
        message: params.message,
      });
      log.info(
        {
          step: "succeeded",
          userId: ctx.userId,
          toolsUsed: response.toolsUsed.length,
        },
        "positions chat complete",
      );
      return { kind: "chat", text: response.reply, parseMode: "Markdown" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, userId: ctx.userId }, "positions chat failed");
      return { kind: "chat", text: `Could not load positions: ${msg}` };
    }
  }
}
