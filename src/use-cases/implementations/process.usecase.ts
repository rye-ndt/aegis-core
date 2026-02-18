import { newUuid } from "../../helpers/uuid";
import {
  IProcessNoteUseCase,
  IQueryData,
  IQueryResponse,
  IRawData,
  IStoreResponse,
} from "../interface/input/process.interface";

import { IError } from "../interface/shared/error";
import { IChunker, TextChunk } from "../interface/output/chunker.interface";
import {
  ICategorizer,
  CategorizedItem,
} from "../interface/output/categorizer.interface";
import type {
  IVectorDB,
  IVectorWithMetadata,
} from "../interface/output/vectorDB.interface";
import {
  IVectorizer,
  ChunkVector,
} from "../interface/output/vectorizer.interface";
import { ISqlDB, ITransaction } from "../interface/output/sqlDB.interface";
import {
  IMaterialDB,
  IMaterialVector,
  IMaterialVectorDB,
  Material,
} from "../interface/output/repository/material.repo";
import {
  IOriginalNoteDB,
  OriginalNote,
} from "../interface/output/repository/originalNote.repo";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { MATERIAL_STATUSES } from "../../helpers/enums/statuses.enum";
import { PRIMARY_CATEGORY } from "../../helpers/enums/categories.enum";

interface PipelineResult {
  chunks: TextChunk[];
  categorizedByChunkId: Map<string, CategorizedItem>;
  chunkVectors: ChunkVector[];
}

interface UserMaterialData {
  userId: string;
  originalNote: OriginalNote;
  originalNoteId: string;
  materials: Material[];
  materialVectors: IMaterialVector[];
  vectors: IVectorWithMetadata[];
}

//defines what user can do to interact with the system
export class ProcessUserRequest implements IProcessNoteUseCase {
  //user can store, retrieve and request for aggregation / compilation
  constructor(
    private readonly vectorizer: IVectorizer,
    private readonly categorizer: ICategorizer,
    private readonly chunker: IChunker,
    private readonly vectorDB: IVectorDB,
    private readonly sqlDB: ISqlDB,
    private readonly materialRepo: IMaterialDB,
    private readonly materialVectorRepo: IMaterialVectorDB,
    private readonly originalNoteRepo: IOriginalNoteDB,
  ) {}

  async processAndStore(data: IRawData): Promise<IStoreResponse> {
    try {
      const pipeline = await this.runPipeline(data.rawData);
      const tx = await this.sqlDB.beginTransaction();
      const originalNoteId = newUuid();

      try {
        const userData = this.buildUserMaterialData(
          data,
          originalNoteId,
          pipeline,
        );

        await this.persistUserMaterialData(tx, userData);
      } catch (err) {
        await tx.rollback();
        throw err;
      }

      return { id: originalNoteId };
    } catch (err) {
      if (err instanceof IError) {
        throw err;
      }

      throw new IError(
        "An unknown error occurred while processing and storing data.",
      );
    }
  }

  private async runPipeline(rawData: string): Promise<PipelineResult> {
    const chunks = await this.chunker.process(rawData);
    const categorizedChunks = await this.categorizer.batchProcess(chunks);
    const categorizedByChunkId = new Map(
      categorizedChunks.map((c) => [c.chunkId, c]),
    );
    const chunkVectors = await this.vectorizer.batchProcess(chunks);
    return { chunks, categorizedByChunkId, chunkVectors };
  }

  private buildUserMaterialData(
    data: IRawData,
    originalNoteId: string,
    pipeline: PipelineResult,
  ): UserMaterialData {
    const { chunks, categorizedByChunkId, chunkVectors } = pipeline;

    const originalNote: OriginalNote = {
      id: originalNoteId,
      userId: data.userID,
      rawData: data.rawData,
      createdAtTimestamp: newCurrentUTCEpoch(),
      updatedAtTimestamp: newCurrentUTCEpoch(),
    };

    const materials: Material[] = [];
    const materialVectors: IMaterialVector[] = [];
    const vectors: IVectorWithMetadata[] = [];

    for (const c of chunks) {
      const cate = categorizedByChunkId.get(c.id);
      const materialId = newUuid();
      const chunkVector = chunkVectors.find((v) => v.chunkId === c.id);
      const vectorId = newUuid();

      materials.push({
        id: materialId,
        userId: data.userID,
        originalNoteId,
        category: cate?.category ?? PRIMARY_CATEGORY.OTHER,
        tags: cate?.tags || [],
        rewrittenContent: c.chunkText,
        originalContent: c.originalText,
        status: MATERIAL_STATUSES.ACTIVE,
        createdAtEpoch: newCurrentUTCEpoch(),
        updatedAtEpoch: newCurrentUTCEpoch(),
      });

      materialVectors.push({
        id: newUuid(),
        materialId,
        vectorId,
        createdAtEpoch: newCurrentUTCEpoch(),
        updatedAtEpoch: newCurrentUTCEpoch(),
      });

      vectors.push({
        id: vectorId,
        chunkId: c.id,
        vector: chunkVector?.vector || [],
        metadata: {
          userId: data.userID,
          primaryCategory: cate?.category ?? PRIMARY_CATEGORY.OTHER,
          tags: cate?.tags || [],
        },
      });
    }

    return {
      userId: data.userID,
      originalNote,
      originalNoteId,
      materials,
      materialVectors,
      vectors,
    };
  }

  private async persistUserMaterialData(
    tx: ITransaction,
    userData: UserMaterialData,
  ): Promise<void> {
    await tx.run(async () => {
      await this.materialRepo.batchCreate(userData.materials);
      await this.materialVectorRepo.batchCreate(userData.materialVectors);
      await this.originalNoteRepo.create(userData.originalNote);
      await this.vectorDB.store(userData.vectors);
    });
  }

  async query(query: IQueryData): Promise<IQueryResponse> {
    void query;
    throw new IError(
      "Query is not implemented: no vector DB retrieve port is wired yet.",
    );
  }
}
