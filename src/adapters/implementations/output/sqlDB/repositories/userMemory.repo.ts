import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IUserMemoryDB,
  UserMemory,
} from "../../../../../use-cases/interface/output/repository/userMemory.repo";
import { userMemories } from "../schema";

export class DrizzleUserMemoryRepo implements IUserMemoryDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(memory: UserMemory): Promise<void> {
    await this.db.insert(userMemories).values({
      id: memory.id,
      userId: memory.userId,
      content: memory.content,
      enrichedContent: memory.enrichedContent ?? null,
      category: memory.category ?? null,
      pineconeId: memory.pineconeId,
      createdAtEpoch: memory.createdAtEpoch,
      updatedAtEpoch: memory.updatedAtEpoch,
      lastAccessedEpoch: memory.lastAccessedEpoch,
    });
  }

  async update(memory: UserMemory): Promise<void> {
    await this.db
      .update(userMemories)
      .set({
        content: memory.content,
        enrichedContent: memory.enrichedContent ?? null,
        category: memory.category ?? null,
        updatedAtEpoch: memory.updatedAtEpoch,
        lastAccessedEpoch: memory.lastAccessedEpoch,
      })
      .where(eq(userMemories.id, memory.id));
  }

  async findByPineconeId(pineconeId: string): Promise<UserMemory | undefined> {
    const rows = await this.db
      .select()
      .from(userMemories)
      .where(eq(userMemories.pineconeId, pineconeId))
      .limit(1);

    if (!rows[0]) return undefined;
    return this.toMemory(rows[0]);
  }

  async findByUserId(userId: string): Promise<UserMemory[]> {
    const rows = await this.db.select().from(userMemories).where(eq(userMemories.userId, userId));
    return rows.map(this.toMemory);
  }

  async updateLastAccessed(id: string, epoch: number): Promise<void> {
    await this.db
      .update(userMemories)
      .set({ lastAccessedEpoch: epoch })
      .where(eq(userMemories.id, id));
  }

  async deleteById(id: string): Promise<void> {
    await this.db.delete(userMemories).where(eq(userMemories.id, id));
  }

  private toMemory(row: typeof userMemories.$inferSelect): UserMemory {
    return {
      id: row.id,
      userId: row.userId,
      content: row.content,
      enrichedContent: row.enrichedContent ?? undefined,
      category: row.category ?? undefined,
      pineconeId: row.pineconeId,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
      lastAccessedEpoch: row.lastAccessedEpoch,
    };
  }
}
