import type { IUserDB } from "./repository/user.repo";
import type { IConversationDB } from "./repository/conversation.repo";
import type { IMessageDB } from "./repository/message.repo";

export interface IPostgresDB {
  close(): Promise<void>;
}

export interface ITransaction {
  run<T>(fn: (tx: ISqlDB) => Promise<T>): Promise<T>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface ISqlDB extends IPostgresDB {
  users?: IUserDB;
  conversations?: IConversationDB;
  messages?: IMessageDB;
  beginTransaction(): Promise<ITransaction>;
}
