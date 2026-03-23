import OpenAI from "openai";
import { z } from "zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type {
  ILLMProvider,
  ITextReplyInput,
  ITextReplyResponse,
  IToolCallInput,
  IToolCallResponse,
} from "../../../../use-cases/interface/output/llmProvider.interface";

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

export class OpenAILLMProvider implements ILLMProvider {
  private readonly client: OpenAI;
  private readonly histories = new Map<string, ChatCompletionMessageParam[]>();

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey, timeout: 20_000, maxRetries: 1 });
  }

  private getHistory(conversationId: string): ChatCompletionMessageParam[] {
    if (!this.histories.has(conversationId)) {
      this.histories.set(conversationId, []);
    }

    return this.histories.get(conversationId)!;
  }

  private toContextPercent(totalTokens: number): number {
    const window = MODEL_CONTEXT_WINDOWS[this.model] ?? DEFAULT_CONTEXT_WINDOW;
    return Math.round((totalTokens / window) * 1000) / 10; // one decimal place
  }

  async textReply(input: ITextReplyInput): Promise<ITextReplyResponse> {
    const history = this.getHistory(input.conversationId);
    if (history.length === 0 && input.systemPrompt) {
      history.push({ role: "system", content: input.systemPrompt });
    }
    history.push({ role: "user", content: input.prompt });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: history,
    });

    const choice = response.choices[0];
    const message = choice.message.content ?? "";
    history.push({ role: "assistant", content: message });

    const contextUsagePercent = this.toContextPercent(
      response.usage?.total_tokens ?? 0,
    );

    return { message, contextUsagePercent };
  }

  async toolCall(input: IToolCallInput): Promise<IToolCallResponse> {
    const history = this.getHistory(input.conversationId);
    history.push({ role: "user", content: input.prompt });

    const tools: OpenAI.Chat.ChatCompletionTool[] = [];
    for (const [toolName, schema] of input.toolList) {
      tools.push({
        type: "function",
        function: {
          name: toolName,
          parameters: z.toJSONSchema(schema) as Record<string, unknown>,
        },
      });
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: history,
      tools,
      tool_choice: "required",
    });

    const choice = response.choices[0];
    const rawToolCall = choice.message.tool_calls?.[0];
    if (!rawToolCall || rawToolCall.type !== "function") {
      throw new Error("LLM did not return a function tool call");
    }

    const toolName = rawToolCall.function.name;
    const rawArgs = JSON.parse(rawToolCall.function.arguments) as Record<
      string,
      unknown
    >;

    const schema = input.toolList.get(toolName);
    const params = schema
      ? (schema.parse(rawArgs) as Record<string, unknown>)
      : rawArgs;

    // Persist tool call + result in history so follow-up calls have context
    history.push(choice.message);

    return { toolName, params };
  }
}
