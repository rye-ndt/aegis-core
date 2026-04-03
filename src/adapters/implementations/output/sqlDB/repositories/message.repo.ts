import { and, eq, inArray, isNull } from "drizzle-orm";
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
      compressedAtEpoch: message.compressedAtEpoch ?? null,
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
      compressedAtEpoch: r.compressedAtEpoch ?? undefined,
    }));
  }

  async findUncompressedByConversationId(conversationId: string): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          isNull(messages.compressedAtEpoch),
        ),
      )
      .orderBy(messages.createdAtEpoch);

    return rows.map((r) => ({
      ...r,
      role: r.role as MESSAGE_ROLE,
      toolName: r.toolName ? (r.toolName as TOOL_TYPE) : undefined,
      toolCallId: r.toolCallId ?? undefined,
      toolCallsJson: r.toolCallsJson ?? undefined,
      compressedAtEpoch: r.compressedAtEpoch ?? undefined,
    }));
  }

  async markCompressed(ids: string[], epoch: number): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(messages)
      .set({ compressedAtEpoch: epoch })
      .where(inArray(messages.id, ids));
  }

  async deleteByConversationId(conversationId: string): Promise<void> {
    await this.db
      .delete(messages)
      .where(eq(messages.conversationId, conversationId));
  }
}
