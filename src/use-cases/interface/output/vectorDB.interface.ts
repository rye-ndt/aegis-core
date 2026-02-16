import { ChunkVector } from "./vectorizer.interface";
import { PRIMARY_CATEGORY } from "../../../helpers/enums/categories.enum";

export interface IVectorMetadata {
  userId: string;
  primaryCategory: PRIMARY_CATEGORY;
  tags: string[];
}

export interface IVectorWithMetadata extends ChunkVector {
  id: string;
  metadata: IVectorMetadata;
}

export interface IVectorDB {
  store(chunkVectors: IVectorWithMetadata[]): Promise<void>;
}

