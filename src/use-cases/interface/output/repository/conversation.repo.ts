import { CONVERSATION_STATUSES } from "../../../../helpers/enums/statuses.enum";

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  status: CONVERSATION_STATUSES;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IConversationDB {
  create(conversation: Conversation): Promise<void>;
  update(conversation: Conversation): Promise<void>;
  findById(id: string): Promise<Conversation | null>;
  findByUserId(userId: string): Promise<Conversation[]>;
  delete(id: string): Promise<void>;
}
