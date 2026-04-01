import { tavily } from "@tavily/core";
import type { IWebSearchResult, IWebSearchService } from "../../../../use-cases/interface/output/webSearch.interface";

export class TavilyWebSearchService implements IWebSearchService {
  private readonly client: ReturnType<typeof tavily>;

  constructor(apiKey: string) {
    this.client = tavily({ apiKey });
  }

  async search(params: { query: string; maxResults: number }): Promise<IWebSearchResult[]> {
    const { query, maxResults } = params;
    const response = await this.client.search(query, {
      maxResults,
      searchDepth: "basic",
    });

    return response.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
    }));
  }
}
