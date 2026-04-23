import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IIntent,
  IIntentDB,
  IntentInit,
} from "../../../../../use-cases/interface/output/repository/intent.repo";
import { INTENT_STATUSES } from "../../../../../helpers/enums/intentStatus.enum";
import { intents } from "../schema";
import { newCurrentUTCEpoch } from "../../../../../helpers/time/dateTime";

export class DrizzleIntentRepo implements IIntentDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(intent: IntentInit): Promise<void> {
    await this.db.insert(intents).values({
      id: intent.id,
      userId: intent.userId,
      conversationId: intent.conversationId,
      messageId: intent.messageId,
      rawInput: intent.rawInput,
      parsedJson: intent.parsedJson,
      status: intent.status,
      rejectionReason: intent.rejectionReason ?? null,
      createdAtEpoch: intent.createdAtEpoch,
      updatedAtEpoch: intent.updatedAtEpoch,
    });
  }

  async updateStatus(id: string, status: INTENT_STATUSES, rejectionReason?: string): Promise<void> {
    await this.db
      .update(intents)
      .set({
        status,
        rejectionReason: rejectionReason ?? null,
        updatedAtEpoch: newCurrentUTCEpoch(),
      })
      .where(eq(intents.id, id));
  }

  async findById(id: string): Promise<IIntent | undefined> {
    const rows = await this.db
      .select()
      .from(intents)
      .where(eq(intents.id, id))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toRecord(rows[0]);
  }

  async findPendingByUserId(userId: string): Promise<IIntent | undefined> {
    const rows = await this.db
      .select()
      .from(intents)
      .where(and(eq(intents.userId, userId), eq(intents.status, INTENT_STATUSES.AWAITING_CONFIRMATION)))
      .orderBy(desc(intents.createdAtEpoch))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toRecord(rows[0]);
  }

  private toRecord(row: typeof intents.$inferSelect): IIntent {
    return {
      id: row.id,
      userId: row.userId,
      conversationId: row.conversationId,
      messageId: row.messageId,
      rawInput: row.rawInput,
      parsedJson: row.parsedJson,
      status: row.status as INTENT_STATUSES,
      rejectionReason: row.rejectionReason,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
