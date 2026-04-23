import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  Conversation,
  IConversationDB,
} from "../../../../../use-cases/interface/output/repository/conversation.repo";
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
}
