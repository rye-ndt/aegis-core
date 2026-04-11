import type { ISqlDB } from "../../../../use-cases/interface/output/sqlDB.interface";

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
import { DrizzlePendingDelegationRepo } from "./repositories/pendingDelegation.repo";

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
  readonly pendingDelegations: DrizzlePendingDelegationRepo;

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
    this.pendingDelegations = new DrizzlePendingDelegationRepo(this.db);
  }

}
