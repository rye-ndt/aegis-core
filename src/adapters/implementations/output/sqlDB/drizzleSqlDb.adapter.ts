import type {
  ISqlDB,
  ITransaction,
} from "../../../../use-cases/interface/output/sqlDB.interface";
import { drizzle } from "drizzle-orm/node-postgres";

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

  async beginTransaction(): Promise<ITransaction> {
    const client = await this.getPool().connect();
    await client.query("BEGIN");
    const txDb = drizzle({ client });
    const originalNotes = new DrizzleOriginalNoteRepo(txDb);
    const txFacade: ISqlDB = {
      originalNotes,
      close: async () => {},
      beginTransaction: async () => {
        throw new Error("Nested transaction not implemented");
      },
    };
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        client.release();
      }
    };
    return {
      run: async <T>(fn: (tx: ISqlDB) => Promise<T>) => {
        try {
          return await fn(txFacade);
        } catch (e) {
          await client.query("ROLLBACK");
          release();
          throw e;
        }
      },
      commit: async () => {
        await client.query("COMMIT");
        release();
      },
      rollback: async () => {
        await client.query("ROLLBACK");
        release();
      },
    };
  }
}
