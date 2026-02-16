import { IMaterialDB } from "./repository/material.repo";
import { IOriginalNoteDB } from "./repository/originalNote.repo";

export interface IPostgresDB {
  close(): Promise<void>;
}

export interface ISqlDB extends IPostgresDB {
  originalNotes: IOriginalNoteDB;
  /**
   * Optional until a concrete SQL implementation is provided.
   * (No current use-case depends on it.)
   */
  materials?: IMaterialDB;
}

