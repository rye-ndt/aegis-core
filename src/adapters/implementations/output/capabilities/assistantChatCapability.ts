import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";

interface AssistantParams {
  message: string;
  conversationId: string | null;
}

/**
 * Free-text chat capability backed by the LLM tool-use loop
 * (AssistantUseCase.chat → OpenAIOrchestrator → ITool registry).
 *
 * This is the "default" capability. The dispatcher will route any free text
 * that doesn't match a command or a pending flow here. It maintains a
 * per-channel conversation id so multi-turn chat context is preserved.
 *
 * NOT YET REGISTERED by default — scaffold for the Step 4/5 migration.
 * Callers that want to wire it up must register it in
 * `AssistantInject.getCapabilityDispatcher` AND add a default-match path
 * on the registry. Left un-wired so legacy `handleFallbackChat` keeps
 * handling free text verbatim until the /send migration lands.
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
    return { kind: "chat", text: response.reply, parseMode: "Markdown" };
  }
}
