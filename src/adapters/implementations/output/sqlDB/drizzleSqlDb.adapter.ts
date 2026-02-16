import type { ISqlDB } from "../../../../use-cases/interface/output/sqlDB.interface";

import { PostgresDB, type PostgresConfig } from "./drizzlePostgres.db";
import { DrizzleOriginalNoteRepo } from "./repositories/originalNote.repo";

/**
 * SQL adapter facade:
 * - owns a single Pool/Drizzle instance
 * - exposes per-table repositories (each with its own signatures)
 */
export class DrizzleSqlDB extends PostgresDB implements ISqlDB {
  readonly originalNotes: DrizzleOriginalNoteRepo;

  constructor(config: PostgresConfig) {
    super(config);
    this.originalNotes = new DrizzleOriginalNoteRepo(this.db);
  }
}

