export interface EvaluationLog {
  id: string;
  conversationId: string;
  messageId: string;
  userId: string;
  systemPromptHash: string;
  memoriesInjected: string;
  toolCalls: string;
  reasoningTrace?: string | null;
  response: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  implicitSignal?: string | null;
  explicitRating?: number | null;
  outcomeConfirmed?: boolean | null;
  contributedAtEpoch?: number | null;
  contributionTxHash?: string | null;
  contributionDataHash?: string | null;
  createdAtEpoch: number;
}

export interface IEvaluationLogDB {
  create(log: EvaluationLog): Promise<void>;
  findLastByConversation(conversationId: string, skip?: number): Promise<EvaluationLog | null>;
  updateImplicitSignal(id: string, signal: string): Promise<void>;
  updateOutcomeConfirmed(id: string, confirmed: boolean): Promise<void>;
  updateExplicitRating(messageId: string, rating: number): Promise<void>;
  markContributed(id: string, txHash: string, dataHash: string, epoch: number): Promise<void>;
  findContributable(userId: string): Promise<EvaluationLog[]>;
}
