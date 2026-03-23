import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  Conversation,
  IConversationDB,
} from "../../../../../use-cases/interface/output/repository/conversation.repo";
import { CONVERSATION_STATUSES } from "../../../../../helpers/enums/statuses.enum";
import { conversations } from "../schema";

export class DrizzleConversationRepo implements IConversationDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(conversation: Conversation): Promise<void> {
    await this.db.insert(conversations).values({
      id: conversation.id,
      userId: conversation.userId,
      title: conversation.title,
      status: conversation.status,
      createdAtEpoch: conversation.createdAtEpoch,
      updatedAtEpoch: conversation.updatedAtEpoch,
    });
  }

  async update(conversation: Conversation): Promise<void> {
    await this.db
      .update(conversations)
      .set({
        title: conversation.title,
        status: conversation.status,
        updatedAtEpoch: conversation.updatedAtEpoch,
      })
      .where(eq(conversations.id, conversation.id));
  }

  async findById(id: string): Promise<Conversation | null> {
    const rows = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);

    if (!rows[0]) return null;
    return { ...rows[0], status: rows[0].status as CONVERSATION_STATUSES };
  }

  async findByUserId(userId: string): Promise<Conversation[]> {
    const rows = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId));

    return rows.map((r) => ({ ...r, status: r.status as CONVERSATION_STATUSES }));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(conversations).where(eq(conversations.id, id));
  }
}
