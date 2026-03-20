import type {
  ISqlDB,
  ITransaction,
} from "../../../../use-cases/interface/output/sqlDB.interface";
import { drizzle } from "drizzle-orm/node-postgres";

import { PostgresDB, type PostgresConfig } from "./drizzlePostgres.db";
import { DrizzleUserRepo } from "./repositories/user.repo";

/**
 * SQL adapter facade:
 * - owns a single Pool/Drizzle instance
 * - exposes per-table repositories (each with its own signatures)
 */
export class DrizzleSqlDB extends PostgresDB implements ISqlDB {
  readonly users: DrizzleUserRepo;

  constructor(config: PostgresConfig) {
    super(config);
    this.users = new DrizzleUserRepo(this.db);
  }

  async beginTransaction(): Promise<ITransaction> {
    const client = await this.getPool().connect();
    await client.query("BEGIN");
    const txDb = drizzle({ client });
    const txFacade: ISqlDB = {
      users: new DrizzleUserRepo(txDb),
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
