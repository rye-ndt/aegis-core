import type { IUserDB } from "./repository/user.repo";
import type { IConversationDB } from "./repository/conversation.repo";
import type { IMessageDB } from "./repository/message.repo";
import type { IUserProfileDB } from "./repository/userProfile.repo";
import type { ITokenRegistryDB } from "./repository/tokenRegistry.repo";
import type { IIntentDB } from "./repository/intent.repo";
import type { IIntentExecutionDB } from "./repository/intentExecution.repo";
import type { IToolManifestDB } from "./repository/toolManifest.repo";
import type { IFeeRecordDB } from "./repository/feeRecord.repo";
import type { IUserPreferencesDB } from "./repository/userPreference.repo";
import type { ITokenDelegationDB } from "./repository/tokenDelegation.repo";

export interface IPostgresDB {
  close(): Promise<void>;
}

export interface ISqlDB extends IPostgresDB {
  users?: IUserDB;
  conversations?: IConversationDB;
  messages?: IMessageDB;
  userProfiles?: IUserProfileDB;
  tokenRegistry?: ITokenRegistryDB;
  intents?: IIntentDB;
  intentExecutions?: IIntentExecutionDB;
  toolManifests?: IToolManifestDB;
  feeRecords?: IFeeRecordDB;
  userPreferences?: IUserPreferencesDB;
  tokenDelegations?: ITokenDelegationDB;
}
