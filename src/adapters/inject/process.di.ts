import { ProcessControllerConcrete } from "../implementations/input/http/process.controller";
import type { IProcessUserRequest } from "../../use-cases/interface/input/process.interface";
import { ProcessUserRequest } from "../../use-cases/implementations/process.usecase";
import type { IChunker } from "../../use-cases/interface/output/chunker.interface";
import type { ICategorizer } from "../../use-cases/interface/output/categorizer.interface";
import type { IVectorDB } from "../../use-cases/interface/output/vectorDB.interface";
import type { IVectorizer } from "../../use-cases/interface/output/vectorizer.interface";

import { OllamaChunker } from "../implementations/output/chunker/semantic.chunker";
import { V1Categorizer } from "../implementations/output/categorizer/v1.categorizer";
import { NomicEmbedder } from "../implementations/output/embedder/nomic.embedder";
import { PineconeRepo } from "../implementations/output/pinecone.repo";

export class ProcessInject {
  private vectorDB: IVectorDB | null = null;
  private vectorizer: IVectorizer | null = null;
  private categorizer: ICategorizer | null = null;
  private chunker: IChunker | null = null;
  private useCase: IProcessUserRequest | null = null;
  private ctl: ProcessControllerConcrete | null = null;

  getVectorDB(): IVectorDB {
    if (!this.vectorDB) {
      this.vectorDB = new PineconeRepo({
        indexHost: process.env.PINECONE_INDEX_HOST ?? "",
      });
    }

    return this.vectorDB;
  }

  getVectorizer(): IVectorizer {
    if (!this.vectorizer) {
      this.vectorizer = new NomicEmbedder({
        modelName: process.env.OLLAMA_EMBED_MODEL ?? "",
        ollamaUrl: process.env.OLLAMA_URL ?? "",
      });
    }

    return this.vectorizer;
  }

  getCategorizer(): ICategorizer {
    if (!this.categorizer) {
      this.categorizer = new V1Categorizer({
        model: process.env.OPENAI_MODEL ?? "",
        apiKey: process.env.OPENAI_API_KEY ?? "",
      });
    }

    return this.categorizer;
  }

  getChunker(): IChunker {
    if (!this.chunker) {
      this.chunker = new OllamaChunker(
        {
          ollamaUrl: process.env.OLLAMA_URL ?? "",
          model: process.env.OLLAMA_CHUNK_MODEL ?? "",
          similarityThreshold: Number(
            process.env.SEMANTIC_CHUNK_SIM_THRESHOLD,
          ),
          maxSentencesPerChunk: Number(
            process.env.SEMANTIC_CHUNK_MAX_SENTENCES,
          ),
          minSentencesPerChunk: Number(
            process.env.SEMANTIC_CHUNK_MIN_SENTENCES,
          ),
        },
        this.getVectorizer(),
      );
    }

    return this.chunker;
  }

  getUseCase(): IProcessUserRequest {
    if (!this.useCase) {
      this.useCase = new ProcessUserRequest(
        this.getVectorizer(),
        this.getCategorizer(),
        this.getChunker(),
        this.getVectorDB(),
      );
    }

    return this.useCase;
  }

  getCtl(): ProcessControllerConcrete {
    if (!this.ctl) {
      this.ctl = new ProcessControllerConcrete(this.getUseCase());
    }

    return this.ctl;
  }
}
