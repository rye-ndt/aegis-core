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
import { DrizzleTelegramSessionRepo } from "./repositories/telegramSession.repo";
import { DrizzleUserProfileRepo } from "./repositories/userProfile.repo";
import { DrizzleTokenRegistryRepo } from "./repositories/tokenRegistry.repo";
import { DrizzleIntentRepo } from "./repositories/intent.repo";
import { DrizzleIntentExecutionRepo } from "./repositories/intentExecution.repo";
import { DrizzleToolManifestRepo } from "./repositories/toolManifest.repo";
import { DrizzleFeeRecordRepo } from "./repositories/feeRecord.repo";

export class DrizzleSqlDB extends PostgresDB implements ISqlDB {
  readonly users: DrizzleUserRepo;
  readonly conversations: DrizzleConversationRepo;
  readonly messages: DrizzleMessageRepo;
  readonly telegramSessions: DrizzleTelegramSessionRepo;
  readonly userProfiles: DrizzleUserProfileRepo;
  readonly tokenRegistry: DrizzleTokenRegistryRepo;
  readonly intents: DrizzleIntentRepo;
  readonly intentExecutions: DrizzleIntentExecutionRepo;
  readonly toolManifests: DrizzleToolManifestRepo;
  readonly feeRecords: DrizzleFeeRecordRepo;

  constructor(config: PostgresConfig) {
    super(config);
    this.users = new DrizzleUserRepo(this.db);
    this.conversations = new DrizzleConversationRepo(this.db);
    this.messages = new DrizzleMessageRepo(this.db);
    this.telegramSessions = new DrizzleTelegramSessionRepo(this.db);
    this.userProfiles = new DrizzleUserProfileRepo(this.db);
    this.tokenRegistry = new DrizzleTokenRegistryRepo(this.db);
    this.intents = new DrizzleIntentRepo(this.db);
    this.intentExecutions = new DrizzleIntentExecutionRepo(this.db);
    this.toolManifests = new DrizzleToolManifestRepo(this.db);
    this.feeRecords = new DrizzleFeeRecordRepo(this.db);
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
