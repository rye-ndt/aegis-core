import type { StructuredToolPayload } from "../output/tool.interface";

export interface IChatInput {
  userId: string;
  /** Omit to start a new conversation */
  conversationId?: string;
  message: string;
  /** Base64 data URL of an attached image, e.g. "data:image/jpeg;base64,..." */
  imageBase64Url?: string;
}

export interface IChatResponse {
  conversationId: string;
  messageId: string;
  reply: string;
  toolsUsed: string[];
  /**
   * The most recent successful tool call's structured payload, if the tool
   * declared one (see `StructuredToolPayload`). Capabilities use this to
   * route into a `result_card` instead of letting the LLM re-format the
   * markdown table. Last-write-wins across rounds — the
   * `assistantResultRouter` treats the trailing tool as the authoritative
   * subject of the user's question.
   */
  lastStructuredToolResult?: {
    toolName: string;
    payload: StructuredToolPayload;
  };
}

export interface IAssistantUseCase {
  chat(input: IChatInput): Promise<IChatResponse>;
}
