import { MESSAGE_ROLE } from "../../../../helpers/enums/messageRole.enum";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";

export interface Message {
  id: string;
  conversationId: string;
  role: MESSAGE_ROLE;
  content: string;
  /** Set when role is TOOL — identifies which tool produced this result */
  toolName?: TOOL_TYPE;
  /** Links a tool result message to its originating tool call */
  toolCallId?: string;
  createdAtEpoch: number;
}

export interface IMessageDB {
  create(message: Message): Promise<void>;
  findByConversationId(conversationId: string): Promise<Message[]>;
  deleteByConversationId(conversationId: string): Promise<void>;
}
