import OpenAI from "openai";
import { openaiLimiter } from "../../../../helpers/concurrency/openaiLimiter";
import type { IEmbeddingService } from "../../../../use-cases/interface/output/embedding.interface";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

export class OpenAIEmbeddingService implements IEmbeddingService {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(input: {
    text: string;
  }): Promise<{ vector: number[]; tokenCount: number }> {
    const response = await openaiLimiter(() =>
      this.client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: input.text,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    );

    const vector = response.data[0].embedding;
    const tokenCount = response.usage.total_tokens;
    return { vector, tokenCount };
  }
}
