import { MESSAGE_ROLE } from "../../../../helpers/enums/messageRole.enum";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";

export interface Message {
  id: string;
  conversationId: string;
  role: MESSAGE_ROLE;
  content: string;
  toolName?: TOOL_TYPE;
  toolCallId?: string;
  toolCallsJson?: string;
  compressedAtEpoch?: number | null;
  createdAtEpoch: number;
}

export interface IMessageDB {
  create(message: Message): Promise<void>;
  findByConversationId(conversationId: string): Promise<Message[]>;
  findUncompressedByConversationId(conversationId: string): Promise<Message[]>;
  findAfterEpoch(
    conversationId: string,
    afterEpoch: number,
    limit: number,
  ): Promise<Message[]>;
  markCompressed(ids: string[], epoch: number): Promise<void>;
  deleteByConversationId(conversationId: string): Promise<void>;
}
