import { tavily } from "@tavily/core";
import { createHash } from "node:crypto";
import type Redis from "ioredis";
import type { IWebSearchResult, IWebSearchService } from "../../../../use-cases/interface/output/webSearch.interface";
import { makeRedisResponseCache } from "../../../../helpers/cache/redisResponseCache";

const TAVILY_CACHE_TTL_SECONDS = Number(process.env.TAVILY_CACHE_TTL_SECONDS ?? 300);

export class TavilyWebSearchService implements IWebSearchService {
  private readonly client: ReturnType<typeof tavily>;
  private readonly cache?: ReturnType<typeof makeRedisResponseCache>;

  constructor(apiKey: string, redis?: Redis) {
    this.client = tavily({ apiKey });
    this.cache = redis ? makeRedisResponseCache(redis, "tavily") : undefined;
  }

  private keyFor(params: { query: string; maxResults: number }): string {
    return createHash("sha1")
      .update(`${params.maxResults}|${params.query.trim().toLowerCase()}`)
      .digest("hex");
  }

  async search(params: { query: string; maxResults: number }): Promise<IWebSearchResult[]> {
    const cacheKey = this.keyFor(params);
    if (this.cache) {
      const cached = await this.cache.get<IWebSearchResult[]>(cacheKey);
      if (cached) return cached;
    }
    const response = await this.client.search(params.query, {
      maxResults: params.maxResults,
      searchDepth: "basic",
    });
    const results: IWebSearchResult[] = response.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
    }));
    if (this.cache) {
      await this.cache.set(cacheKey, results, TAVILY_CACHE_TTL_SECONDS);
    }
    return results;
  }
}
