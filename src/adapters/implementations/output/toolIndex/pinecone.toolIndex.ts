import type { IEmbeddingService } from "../../../../use-cases/interface/output/embedding.interface";
import type { IVectorStore } from "../../../../use-cases/interface/output/vectorDB.interface";
import type { IToolIndexService } from "../../../../use-cases/interface/output/toolIndex.interface";

const DEFAULT_MIN_SCORE = 0.3;
// Fetch extra results so chainId post-filtering still yields enough candidates.
// IVectorStore.query filter is Record<string,string> — no $in operator — so we
// filter chainIds client-side after retrieval.
const CHAIN_FILTER_FETCH_MULTIPLIER = 3;

function serializeChainIds(chainIds: number[]): string {
  return chainIds.join(",");
}

function parseChainIds(raw: string): number[] {
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

export class PineconeToolIndexService implements IToolIndexService {
  constructor(
    private readonly embeddingService: IEmbeddingService,
    private readonly vectorStore: IVectorStore,
  ) {}

  async index(params: {
    id: string;
    toolId: string;
    text: string;
    category: string;
    chainIds: number[];
  }): Promise<void> {
    const { vector } = await this.embeddingService.embed({ text: params.text });
    await this.vectorStore.upsert({
      id: params.id,
      vector,
      metadata: {
        type: "tool",
        toolId: params.toolId,
        category: params.category,
        chainIds: serializeChainIds(params.chainIds),
      },
    });
  }

  async search(
    query: string,
    options: { topK: number; chainId?: number; minScore?: number },
  ): Promise<{ toolId: string; score: number }[]> {
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const { vector } = await this.embeddingService.embed({ text: query });

    const fetchK = options.chainId != null
      ? options.topK * CHAIN_FILTER_FETCH_MULTIPLIER
      : options.topK;
    const results = await this.vectorStore.query(vector, fetchK, { type: "tool" });

    return results
      .filter((r) => {
        if (r.score < minScore) return false;
        if (options.chainId == null) return true;
        const chainIds = parseChainIds(String(r.metadata.chainIds ?? ""));
        return chainIds.includes(options.chainId);
      })
      .slice(0, options.topK)
      .map((r) => ({ toolId: String(r.metadata.toolId), score: r.score }));
  }

  async delete(id: string): Promise<void> {
    await this.vectorStore.delete(id);
  }
}
