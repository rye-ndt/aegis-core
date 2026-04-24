import { MESSAGE_ROLE } from "../../../../helpers/enums/messageRole.enum";

export interface Message {
  id: string;
  conversationId: string;
  role: MESSAGE_ROLE;
  content: string;
  toolName?: string;
  toolCallId?: string;
  toolCallsJson?: string;
  createdAtEpoch: number;
}

export interface IMessageDB {
  create(message: Message): Promise<void>;
  findByConversationId(conversationId: string, limit?: number): Promise<Message[]>;
  deleteByConversationId(conversationId: string): Promise<void>;
}
