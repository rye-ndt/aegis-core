import { and, desc, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  EvaluationLog,
  IEvaluationLogDB,
} from "../../../../../use-cases/interface/output/repository/evaluationLog.repo";
import { evaluationLogs } from "../schema";

export class DrizzleEvaluationLogRepo implements IEvaluationLogDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(log: EvaluationLog): Promise<void> {
    await this.db.insert(evaluationLogs).values({
      id: log.id,
      conversationId: log.conversationId,
      messageId: log.messageId,
      userId: log.userId,
      systemPromptHash: log.systemPromptHash,
      memoriesInjected: log.memoriesInjected,
      toolCalls: log.toolCalls,
      reasoningTrace: log.reasoningTrace ?? null,
      response: log.response,
      promptTokens: log.promptTokens ?? null,
      completionTokens: log.completionTokens ?? null,
      implicitSignal: log.implicitSignal ?? null,
      explicitRating: log.explicitRating ?? null,
      outcomeConfirmed: log.outcomeConfirmed ?? null,
      createdAtEpoch: log.createdAtEpoch,
    });
  }

  async findLastByConversation(
    conversationId: string,
    skip = 0,
  ): Promise<EvaluationLog | null> {
    const rows = await this.db
      .select()
      .from(evaluationLogs)
      .where(eq(evaluationLogs.conversationId, conversationId))
      .orderBy(desc(evaluationLogs.createdAtEpoch))
      .limit(1)
      .offset(skip);

    if (!rows[0]) return null;
    return {
      ...rows[0],
      reasoningTrace: rows[0].reasoningTrace ?? undefined,
      promptTokens: rows[0].promptTokens ?? undefined,
      completionTokens: rows[0].completionTokens ?? undefined,
      implicitSignal: rows[0].implicitSignal ?? undefined,
      explicitRating: rows[0].explicitRating ?? undefined,
      outcomeConfirmed: rows[0].outcomeConfirmed ?? undefined,
    };
  }

  async updateImplicitSignal(id: string, signal: string): Promise<void> {
    await this.db
      .update(evaluationLogs)
      .set({ implicitSignal: signal })
      .where(eq(evaluationLogs.id, id));
  }

  async updateOutcomeConfirmed(id: string, confirmed: boolean): Promise<void> {
    await this.db
      .update(evaluationLogs)
      .set({ outcomeConfirmed: confirmed })
      .where(eq(evaluationLogs.id, id));
  }

  async updateExplicitRating(messageId: string, rating: number): Promise<void> {
    await this.db
      .update(evaluationLogs)
      .set({ explicitRating: rating })
      .where(eq(evaluationLogs.messageId, messageId));
  }

  async markContributed(id: string, txHash: string, dataHash: string, epoch: number): Promise<void> {
    await this.db
      .update(evaluationLogs)
      .set({ contributionTxHash: txHash, contributionDataHash: dataHash, contributedAtEpoch: epoch })
      .where(eq(evaluationLogs.id, id));
  }

  async findContributable(userId: string): Promise<EvaluationLog[]> {
    const rows = await this.db
      .select()
      .from(evaluationLogs)
      .where(and(eq(evaluationLogs.userId, userId), isNull(evaluationLogs.contributedAtEpoch)))
      .orderBy(desc(evaluationLogs.createdAtEpoch));

    return rows.map((r) => ({
      ...r,
      reasoningTrace: r.reasoningTrace ?? undefined,
      promptTokens: r.promptTokens ?? undefined,
      completionTokens: r.completionTokens ?? undefined,
      implicitSignal: r.implicitSignal ?? undefined,
      explicitRating: r.explicitRating ?? undefined,
      outcomeConfirmed: r.outcomeConfirmed ?? undefined,
      contributedAtEpoch: r.contributedAtEpoch ?? undefined,
      contributionTxHash: r.contributionTxHash ?? undefined,
      contributionDataHash: r.contributionDataHash ?? undefined,
    }));
  }
}
