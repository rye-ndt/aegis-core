import type { Conversation } from "../output/repository/conversation.repo";
import type { Message } from "../output/repository/message.repo";

export interface IChatInput {
  userId: string;
  /** Omit to start a new conversation */
  conversationId?: string;
  /** Already-transcribed text from the user */
  message: string;
  /** Base64 data URL of an attached image, e.g. "data:image/jpeg;base64,..." */
  imageBase64Url?: string;
}

export interface IChatResponse {
  conversationId: string;
  messageId: string;
  reply: string;
  /** Names of tools that were invoked to produce this reply */
  toolsUsed: string[];
}

export interface IVoiceChatInput {
  userId: string;
  conversationId?: string;
  audioBuffer: Buffer;
  mimeType: string;
}

export interface IListConversationsInput {
  userId: string;
}

export interface IGetConversationInput {
  userId: string;
  conversationId: string;
}

export interface IAssistantUseCase {
  /** Send a text message and receive a reply */
  chat(input: IChatInput): Promise<IChatResponse>;
  /** Send a voice clip; it is transcribed then processed as a chat message */
  voiceChat(input: IVoiceChatInput): Promise<IChatResponse>;
  /** List all conversations for a user */
  listConversations(input: IListConversationsInput): Promise<Conversation[]>;
  /** Get the full message history of a conversation */
  getConversation(input: IGetConversationInput): Promise<Message[]>;
}
