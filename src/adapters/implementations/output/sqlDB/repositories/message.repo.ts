import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  Message,
  IMessageDB,
} from "../../../../../use-cases/interface/output/repository/message.repo";
import { MESSAGE_ROLE } from "../../../../../helpers/enums/messageRole.enum";
import { TOOL_TYPE } from "../../../../../helpers/enums/toolType.enum";
import { messages } from "../schema";

export class DrizzleMessageRepo implements IMessageDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(message: Message): Promise<void> {
    await this.db.insert(messages).values({
      id: message.id,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      toolName: message.toolName ?? null,
      toolCallId: message.toolCallId ?? null,
      toolCallsJson: message.toolCallsJson ?? null,
      createdAtEpoch: message.createdAtEpoch,
    });
  }

  async findByConversationId(conversationId: string): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));

    return rows.map((r) => ({
      ...r,
      role: r.role as MESSAGE_ROLE,
      toolName: r.toolName ? (r.toolName as TOOL_TYPE) : undefined,
      toolCallId: r.toolCallId ?? undefined,
      toolCallsJson: r.toolCallsJson ?? undefined,
    }));
  }

  async deleteByConversationId(conversationId: string): Promise<void> {
    await this.db
      .delete(messages)
      .where(eq(messages.conversationId, conversationId));
  }
}
