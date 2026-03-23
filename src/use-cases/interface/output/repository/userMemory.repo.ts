export interface UserMemory {
  id: string;
  userId: string;
  content: string;
  enrichedContent?: string;
  category?: string;
  pineconeId: string;
  createdAtEpoch: number;
  updatedAtEpoch: number;
  lastAccessedEpoch: number;
}

export interface IUserMemoryDB {
  create(memory: UserMemory): Promise<void>;
  /** Update content/enrichedContent/category for deduplication (upsert by same Pinecone ID). */
  update(memory: UserMemory): Promise<void>;
  findByPineconeId(pineconeId: string): Promise<UserMemory | undefined>;
  findByUserId(userId: string): Promise<UserMemory[]>;
  /** Stamp the lastAccessedEpoch on every retrieval hit. */
  updateLastAccessed(id: string, epoch: number): Promise<void>;
  deleteById(id: string): Promise<void>;
}
