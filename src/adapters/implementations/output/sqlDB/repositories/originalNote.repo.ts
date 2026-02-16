import { desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type {
  IOriginalNoteDB,
  OriginalNote,
  OriginalNoteCreate,
} from "../../../../../use-cases/interface/output/repository/originalNote.repo";
import { originalNotes } from "../schema";

export class DrizzleOriginalNoteRepo implements IOriginalNoteDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(note: OriginalNoteCreate): Promise<void> {
    await this.db.insert(originalNotes).values(note);
  }

  async findById(id: string): Promise<OriginalNote | null> {
    const rows = await this.db
      .select()
      .from(originalNotes)
      .where(eq(originalNotes.id, id))
      .limit(1);

    return rows[0] ?? null;
  }

  async findByIds(ids: string[]): Promise<OriginalNote[]> {
    if (ids.length === 0) return [];

    return await this.db
      .select()
      .from(originalNotes)
      .where(inArray(originalNotes.id, ids));
  }

  async findLatestByUserId(
    userId: string,
    limit: number,
  ): Promise<OriginalNote[]> {
    return await this.db
      .select()
      .from(originalNotes)
      .where(eq(originalNotes.userId, userId))
      .orderBy(desc(originalNotes.createdAtTimestamp))
      .limit(limit);
  }
}

