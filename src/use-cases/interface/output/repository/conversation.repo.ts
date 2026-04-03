import { CONVERSATION_STATUSES } from "../../../../helpers/enums/statuses.enum";

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  status: CONVERSATION_STATUSES;
  summary?: string | null;
  intent?: string | null;
  flaggedForCompression: boolean;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IConversationDB {
  create(conversation: Conversation): Promise<void>;
  update(conversation: Conversation): Promise<void>;
  findById(id: string): Promise<Conversation | null>;
  findByUserId(userId: string): Promise<Conversation[]>;
  delete(id: string): Promise<void>;
  upsertSummary(id: string, summary: string): Promise<void>;
  updateIntent(id: string, intent: string): Promise<void>;
  flagForCompression(id: string): Promise<void>;
}
