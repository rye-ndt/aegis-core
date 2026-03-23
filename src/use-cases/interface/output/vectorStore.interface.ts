export interface IVectorStoreRecord {
  id: string;
  vector: number[];
  metadata: Record<string, string | number | boolean>;
}

export interface IVectorQueryResult {
  id: string;
  score: number;
  metadata: Record<string, string | number | boolean>;
}

export interface IVectorStore {
  upsert(record: IVectorStoreRecord): Promise<void>;
  query(
    vector: number[],
    topK: number,
    filter?: Record<string, string>,
  ): Promise<IVectorQueryResult[]>;
  delete(id: string): Promise<void>;
}
