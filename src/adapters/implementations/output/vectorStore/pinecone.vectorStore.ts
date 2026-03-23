import { Pinecone } from "@pinecone-database/pinecone";
import type {
  IVectorStore,
  IVectorStoreRecord,
  IVectorQueryResult,
} from "../../../../use-cases/interface/output/vectorStore.interface";

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
    const response = await this.index.query({
      vector,
      topK,
      filter: filter as Record<string, unknown>,
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
