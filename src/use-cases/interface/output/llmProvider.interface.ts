import type { ZodTypeAny } from "zod";

export interface ITextReplyInput {
  prompt: string;
  conversationId: string;
  /** Injected as a system message on the first turn of a new conversation. */
  systemPrompt?: string;
}

export interface ITextReplyResponse {
  message: string;
  /** Percentage of the model's context window consumed by this exchange */
  contextUsagePercent: number;
}

export interface IToolCallInput {
  prompt: string;
  conversationId: string;
  /**
   * Map of tool name → Zod schema describing the params that tool expects.
   * The LLM will pick one tool and return params conforming to its schema.
   */
  toolList: Map<string, ZodTypeAny>;
}

export interface IToolCallResponse {
  toolName: string;
  /** Params object validated against the chosen tool's Zod schema */
  params: Record<string, unknown>;
}

export interface ILLMProvider {
  textReply(input: ITextReplyInput): Promise<ITextReplyResponse>;
  toolCall(input: IToolCallInput): Promise<IToolCallResponse>;
}
