export interface ICommandToolMappingRecord {
  command: string;       // bare word, e.g. "buy"
  toolId: string;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface ICommandToolMappingDB {
  /** Insert or overwrite the mapping for this command (bare word). */
  upsert(record: ICommandToolMappingRecord): Promise<void>;
  /** Returns the record for the bare-word command, or undefined if none. */
  findByCommand(command: string): Promise<ICommandToolMappingRecord | undefined>;
  /** Returns all mappings. */
  listAll(): Promise<ICommandToolMappingRecord[]>;
  /** Removes the mapping for this command. Throws if not found. */
  delete(command: string): Promise<void>;
}
