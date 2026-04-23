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
}

export interface IAssistantUseCase {
  chat(input: IChatInput): Promise<IChatResponse>;
}
