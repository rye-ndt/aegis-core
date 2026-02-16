import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import {
  IVectorDB,
  IVectorWithMetadata,
} from "../../../use-cases/interface/output/vectorDB.interface";

type PineconeMetadata = {
  id: string;
  chunkId: string;
  userId: string;
  primaryCategory: string;
  tags: string[];
};

type Config = {
  indexHost: string;
};

type PineconeIndex = ReturnType<PineconeClient["index"]>;

export class PineconeRepo implements IVectorDB {
  private readonly index: PineconeIndex;

  constructor(config: Config) {
    const pinecone = new PineconeClient();

    const host = config.indexHost;
    if (!host) {
      throw new Error("PINECONE_INDEX_HOST or config.indexHost is required.");
    }

    this.index = pinecone.index<PineconeMetadata>({ host });
  }

  async store(chunkVectors: IVectorWithMetadata[]): Promise<void> {
    if (!chunkVectors?.length) {
      return;
    }

    const records = chunkVectors.map((v) => ({
      id: `${v.metadata.userId}:${v.id}:${v.chunkId}`,
      values: v.vector,
      metadata: {
        id: v.id,
        chunkId: v.chunkId,
        userId: v.metadata.userId,
        primaryCategory: v.metadata.primaryCategory,
        tags: v.metadata.tags,
      },
    }));

    await this.index.upsert({ records });
  }
}
