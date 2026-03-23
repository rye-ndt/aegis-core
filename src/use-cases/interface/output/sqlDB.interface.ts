import type { IUserDB } from "./repository/user.repo";
import type { IConversationDB } from "./repository/conversation.repo";
import type { IMessageDB } from "./repository/message.repo";
import type { IGoogleOAuthTokenDB } from "./repository/googleOAuthToken.repo";

export interface IPostgresDB {
  close(): Promise<void>;
}

/**
 * Open transaction handle. Use run() to execute one or more callbacks within the same transaction.
 * Call commit() or rollback() when done.
 */
export interface ITransaction {
  run<T>(fn: (tx: ISqlDB) => Promise<T>): Promise<T>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface ISqlDB extends IPostgresDB {
  users?: IUserDB;
  conversations?: IConversationDB;
  messages?: IMessageDB;
  googleOAuthTokens?: IGoogleOAuthTokenDB;
  /** Starts a transaction. Pass callbacks to run(); then commit() or rollback(). */
  beginTransaction(): Promise<ITransaction>;
}
