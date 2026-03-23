import type {
  ISqlDB,
  ITransaction,
} from "../../../../use-cases/interface/output/sqlDB.interface";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { PostgresDB, type PostgresConfig } from "./drizzlePostgres.db";
import { DrizzleUserRepo } from "./repositories/user.repo";
import { DrizzleConversationRepo } from "./repositories/conversation.repo";
import { DrizzleMessageRepo } from "./repositories/message.repo";
import { DrizzleJarvisConfigRepo } from "./repositories/jarvisConfig.repo";
import { DrizzleUserMemoryRepo } from "./repositories/userMemory.repo";

/**
 * SQL adapter facade:
 * - owns a single Pool/Drizzle instance
 * - exposes per-table repositories (each with its own signatures)
 */
export class DrizzleSqlDB extends PostgresDB implements ISqlDB {
  readonly users: DrizzleUserRepo;
  readonly conversations: DrizzleConversationRepo;
  readonly messages: DrizzleMessageRepo;
  readonly jarvisConfig: DrizzleJarvisConfigRepo;
  readonly userMemories: DrizzleUserMemoryRepo;

  constructor(config: PostgresConfig) {
    super(config);
    this.users = new DrizzleUserRepo(this.db);
    this.conversations = new DrizzleConversationRepo(this.db);
    this.messages = new DrizzleMessageRepo(this.db);
    this.jarvisConfig = new DrizzleJarvisConfigRepo(this.db);
    this.userMemories = new DrizzleUserMemoryRepo(this.db);
  }

  async runMigrations(migrationsFolder: string): Promise<void> {
    await migrate(this.db, { migrationsFolder });
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
