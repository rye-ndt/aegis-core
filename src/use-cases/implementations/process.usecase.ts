import { newUuid } from "../../helpers/uuid";
import {
  IProcessUserRequest,
  IQueryData,
  IQueryResponse,
  IRawData,
  IStoreResponse,
} from "../interface/input/process.interface";

import { IError } from "../interface/shared/error";
import { IChunker } from "../interface/output/chunker.interface";
import { ICategorizer } from "../interface/output/categorizer.interface";
import type { IVectorDB, IVectorWithMetadata } from "../interface/output/vectorDB.interface";
import { IVectorizer } from "../interface/output/vectorizer.interface";
import { PRIMARY_CATEGORY } from "../../helpers/enums/categories.enum";

//defines what user can do to interact with the system
export class ProcessUserRequest implements IProcessUserRequest {
  private vectorizer: IVectorizer;
  private categorizer: ICategorizer;
  private chunker: IChunker;
  private vectorDB: IVectorDB;

  //user can store, retrieve and request for aggregation / compilation
  constructor(
    vectorizer: IVectorizer,
    categorizer: ICategorizer,
    chunker: IChunker,
    vectorDB: IVectorDB,
  ) {
    this.vectorizer = vectorizer;
    this.categorizer = categorizer;
    this.chunker = chunker;
    this.vectorDB = vectorDB;
  }

  async processAndStore(data: IRawData): Promise<IStoreResponse> {
    try {
      const chunks = await this.chunker.process(data.rawData);
      const categorizedChunks = await this.categorizer.batchProcess(chunks);
      const categorizedByChunkId = new Map(
        categorizedChunks.map((c) => [c.chunkId, c] as const),
      );

      const chunkVectors = await this.vectorizer.batchProcess(chunks);

      const batchId = newUuid();
      const vectors: IVectorWithMetadata[] = chunkVectors.map((v) => {
        const categorized = categorizedByChunkId.get(v.chunkId);
        return {
          ...v,
          id: batchId,
          metadata: {
            userId: data.userID,
            primaryCategory: categorized?.category ?? PRIMARY_CATEGORY.OTHER,
            tags: categorized?.tags ?? [],
          },
        };
      });

      await this.vectorDB.store(vectors);

      return {
        id: batchId,
      };
    } catch (err) {
      if (err instanceof IError) {
        throw err;
      }

      throw new IError(
        "An unknown error occurred while processing and storing data.",
      );
    }
  }

  async query(query: IQueryData): Promise<IQueryResponse> {
    void query;
    throw new IError(
      "Query is not implemented: no vector DB retrieve port is wired yet.",
    );
  }
}
