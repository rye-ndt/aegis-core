import axios from "axios";
import { TextChunk } from "../../../../use-cases/interface/output/chunker.interface";
import {
  ChunkVector,
  IVectorizer,
} from "../../../../use-cases/interface/output/vectorizer.interface";

interface Config {
  modelName: string;
  ollamaUrl: string;
}

interface OllamaEmbeddingResponse {
  embedding: number[];
}

export class NomicEmbedder implements IVectorizer {
  constructor(private readonly config: Config) {}

  async process(text: string): Promise<number[]> {
    const { data } = await axios.post<OllamaEmbeddingResponse>(
      this.config.ollamaUrl,
      {
        model: this.config.modelName,
        prompt: text,
      },
    );

    return data.embedding;
  }

  async batchProcess(chunks: TextChunk[]): Promise<ChunkVector[]> {
    const results = await Promise.all(
      chunks.map(async (chunk): Promise<ChunkVector> => {
        const { data } = await axios.post<OllamaEmbeddingResponse>(
          this.config.ollamaUrl,
          {
            model: this.config.modelName,
            prompt: chunk.chunkText,
          },
        );

        return {
          chunkId: chunk.id,
          vector: data.embedding,
        };
      }),
    );
    return results;
  }
}

