import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";
import { routeStructuredToolResult } from "./assistantResultRouter";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("assistantChatCapability");

interface AssistantParams {
  message: string;
  conversationId: string | null;
}

/**
 * Free-text chat capability backed by the LLM tool-use loop
 * (AssistantUseCase.chat → OpenAIOrchestrator → ITool registry).
 *
 * This is the "default" capability. The dispatcher routes any free text
 * that doesn't match a command or a pending flow here. It maintains a
 * per-channel conversation id so multi-turn chat context is preserved.
 *
 * Result-card framework wiring (plan §5.2.5):
 * - When the underlying LLM round-tripped a read-only tool that knows how to
 *   produce a `StructuredToolPayload` (transfer history, stock positions,
 *   stock quote, portfolio), the use case surfaces it via
 *   `IChatResponse.lastStructuredToolResult`. We hand that payload to
 *   `assistantResultRouter` to build a clean `result_card`. The LLM's
 *   markdown reply is suppressed in that case.
 * - Otherwise we fall back to forwarding the LLM's prose as `kind:"chat"`.
 *   Plain free-text answers ("what's the price of bitcoin?", general crypto
 *   questions) keep their conversational shape.
 */
export class AssistantChatCapability implements Capability<AssistantParams> {
  readonly id = "assistant_chat";
  readonly triggers: TriggerSpec = {}; // default-match only, no command/callback

  /** channelId → conversationId for multi-turn LLM context. */
  private readonly conversations = new Map<string, string>();

  constructor(private readonly assistantUseCase: IAssistantUseCase) {}

  async collect(ctx: CapabilityCtx): Promise<CollectResult<AssistantParams>> {
    if (ctx.input.kind !== "text") {
      return { kind: "ok", params: { message: "", conversationId: null } };
    }
    return {
      kind: "ok",
      params: {
        message: ctx.input.text,
        conversationId: this.conversations.get(ctx.channelId) ?? null,
      },
    };
  }

  async run(params: AssistantParams, ctx: CapabilityCtx): Promise<Artifact> {
    if (!params.message) return { kind: "noop" };
    const response = await this.assistantUseCase.chat({
      userId: ctx.userId,
      conversationId: params.conversationId ?? undefined,
      message: params.message,
    });
    this.conversations.set(ctx.channelId, response.conversationId);

    // Structured-tool routing: if the LLM round-tripped a known read-only
    // tool, prefer the canonical card over the markdown table the LLM tried
    // to write. The LLM's prose is dropped on this branch — by design.
    if (response.lastStructuredToolResult) {
      const card = routeStructuredToolResult(
        response.lastStructuredToolResult.toolName,
        response.lastStructuredToolResult.payload,
      );
      if (card) {
        log.info(
          {
            step: "succeeded",
            mode: "result-card",
            toolName: response.lastStructuredToolResult.toolName,
            verb: card.verb,
          },
          "assistant-chat",
        );
        return { kind: "result_card", result: card };
      }
    }

    log.info(
      { step: "succeeded", mode: "prose", toolsUsed: response.toolsUsed.length },
      "assistant-chat",
    );
    return { kind: "chat", text: response.reply, parseMode: "Markdown" };
  }
}
