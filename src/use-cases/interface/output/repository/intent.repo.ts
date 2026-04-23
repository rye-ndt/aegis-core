import type { INTENT_STATUSES } from "../../../../helpers/enums/intentStatus.enum";

export interface IIntent {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  rawInput: string;
  parsedJson: string;
  status: INTENT_STATUSES;
  rejectionReason?: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IntentInit {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  rawInput: string;
  parsedJson: string;
  status: INTENT_STATUSES;
  rejectionReason?: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IIntentDB {
  create(intent: IntentInit): Promise<void>;
  updateStatus(id: string, status: INTENT_STATUSES, rejectionReason?: string): Promise<void>;
  findById(id: string): Promise<IIntent | undefined>;
  findPendingByUserId(userId: string): Promise<IIntent | undefined>;
}
