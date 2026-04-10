import { Pinecone } from "@pinecone-database/pinecone";
import type {
  IVectorStore,
  IVectorStoreRecord,
  IVectorQueryResult,
} from "../../../../use-cases/interface/output/vectorDB.interface";

export class PineconeVectorStore implements IVectorStore {
  private readonly index;

  constructor(apiKey: string, indexName: string, host?: string) {
    const client = new Pinecone({ apiKey });
    // Providing host skips the describe-index API call on first use
    this.index = host ? client.index({ host }) : client.index(indexName);
  }

  async upsert(record: IVectorStoreRecord): Promise<void> {
    await this.index.upsert({
      records: [
        {
          id: record.id,
          values: record.vector,
          metadata: record.metadata,
        },
      ],
    });
  }

  async query(
    vector: number[],
    topK: number,
    filter?: Record<string, string>,
  ): Promise<IVectorQueryResult[]> {
    // Pinecone v7 requires MongoDB-style operators: { key: { $eq: value } }
    const pineconeFilter = filter
      ? Object.fromEntries(Object.entries(filter).map(([k, v]) => [k, { $eq: v }]))
      : undefined;

    const response = await this.index.query({
      vector,
      topK,
      filter: pineconeFilter as Record<string, unknown>,
      includeMetadata: true,
    });

    return (response.matches ?? []).map((m) => ({
      id: m.id,
      score: m.score ?? 0,
      metadata: (m.metadata ?? {}) as Record<string, string | number | boolean>,
    }));
  }

  async delete(id: string): Promise<void> {
    await this.index.deleteOne({ id });
  }
}
