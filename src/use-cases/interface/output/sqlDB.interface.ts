import { IMaterialDB } from "./repository/material.repo";
import { IOriginalNoteDB } from "./repository/originalNote.repo";
import type { IUserDB } from "./repository/user.repo";

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
  originalNotes: IOriginalNoteDB;
  /**
   * Optional until a concrete SQL implementation is provided.
   * (No current use-case depends on it.)
   */
  materials?: IMaterialDB;
  users?: IUserDB;
  /** Starts a transaction. Pass callbacks to run(); then commit() or rollback(). */
  beginTransaction(): Promise<ITransaction>;
}
