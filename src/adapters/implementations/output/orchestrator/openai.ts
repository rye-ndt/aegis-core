import OpenAI from "openai";
import { openaiLimiter } from "../../../../helpers/concurrency/openaiLimiter";
import { metricsRegistry } from "../../../../helpers/observability/metricsRegistry";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { MESSAGE_ROLE } from "../../../../helpers/enums/messageRole.enum";
import type {
  ILLMOrchestrator,
  IOrchestratorInput,
  IOrchestratorResponse,
  IToolCall,
  IOrchestratorMessage,
} from "../../../../use-cases/interface/output/orchestrator.interface";

const log = createLogger("openaiOrchestrator");

export class OpenAIOrchestrator implements ILLMOrchestrator {
  private readonly client: OpenAI;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async chat(input: IOrchestratorInput): Promise<IOrchestratorResponse> {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: input.systemPrompt },
      ...input.conversationHistory.map((msg): ChatCompletionMessageParam => {
        if (
          msg.role === MESSAGE_ROLE.ASSISTANT_TOOL_CALL &&
          msg.toolCallsJson
        ) {
          return this.toOpenAiToolCallMessage(msg);
        }
        if (msg.role === MESSAGE_ROLE.TOOL) {
          return {
            role: "tool",
            tool_call_id: msg.toolCallId!,
            content: msg.content,
          };
        }
        if (msg.role === MESSAGE_ROLE.USER && msg.imageBase64Url) {
          return {
            role: "user",
            content: [
              { type: "text" as const, text: msg.content || "What's in this image?" },
              { type: "image_url" as const, image_url: { url: msg.imageBase64Url } },
            ],
          };
        }
        return {
          role: msg.role as "user" | "assistant" | "system",
          content: msg.content,
        };
      }),
    ];

    const tools: ChatCompletionTool[] = input.availableTools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));

    log.debug({ model: this.model, messageCount: messages.length, toolCount: tools.length }, "calling model");
    const startedAt = Date.now();
    const response = await openaiLimiter(() =>
      this.client.chat.completions.create({
        model: this.model,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      }),
    );
    const elapsed = Date.now() - startedAt;
    const cached = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const prompt = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;
    metricsRegistry.recordLlmCall(elapsed, prompt, cached, completionTokens);
    const cacheHitRatio = prompt > 0 ? (cached / prompt).toFixed(2) : "0.00";
    log.info(
      {
        step: "llm-response",
        latencyMs: elapsed,
        finishReason: response.choices[0]?.finish_reason,
        promptTokens: prompt,
        cachedTokens: cached,
        cacheHitRatio,
        completionTokens,
      },
      "model response received",
    );

    const choice = response.choices[0];
    const message = choice.message;

    const usage = response.usage
      ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
        }
      : undefined;

    if (message.tool_calls && message.tool_calls.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolCalls: IToolCall[] = (message.tool_calls as any[])
        .filter((tc) => tc.type === "function")
        .map((tc) => ({
          id: tc.id as string,
          toolName: tc.function.name as string,
          input: JSON.parse(tc.function.arguments as string) as Record<
            string,
            unknown
          >,
        }));

      for (const tc of toolCalls) {
        log.debug({ choice: "tool", name: tc.toolName, callId: tc.id }, "tool call dispatched");
      }

      return { toolCalls, usage };
    }

    return { text: message.content ?? "", usage };
  }

  private toOpenAiToolCallMessage(
    msg: IOrchestratorMessage,
  ): ChatCompletionMessageParam {
    const toolCalls: IToolCall[] = JSON.parse(msg.toolCallsJson!);
    return {
      role: "assistant",
      content: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.toolName,
          arguments: JSON.stringify(tc.input),
        },
      })) as any,
    };
  }
}
