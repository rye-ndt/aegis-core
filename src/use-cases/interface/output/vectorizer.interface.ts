import { TextChunk } from "./chunker.interface";

export interface ChunkVector {
  chunkId: string;
  vector: number[];
}

export interface IVectorizer {
  process(text: string): Promise<number[]>;
  batchProcess(chunks: TextChunk[]): Promise<ChunkVector[]>;
}

