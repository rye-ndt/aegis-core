import type { CrawledToken, ITokenCrawlerJob } from "../../../../use-cases/interface/output/tokenCrawler.interface";

const DEFAULT_PANGOLIN_LIST_URL = "https://raw.githubusercontent.com/pangolindex/tokenlists/main/pangolin.tokenlist.json";
const PANGOLIN_TOKEN_LIST_URL = process.env.PANGOLIN_TOKEN_LIST_URL ?? DEFAULT_PANGOLIN_LIST_URL;

export class PangolinTokenCrawler implements ITokenCrawlerJob {
  async fetchTokens(chainId: number): Promise<CrawledToken[]> {
    const url = PANGOLIN_TOKEN_LIST_URL;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[PangolinTokenCrawler] HTTP ${res.status} from ${url}`);
        return [];
      }
      const json = await res.json() as { tokens?: unknown[] };
      if (!Array.isArray(json.tokens)) return [];

      const result: CrawledToken[] = [];
      for (const t of json.tokens) {
        const token = t as Record<string, unknown>;
        if (
          typeof token.address !== "string" ||
          typeof token.symbol !== "string" ||
          typeof token.name !== "string" ||
          typeof token.decimals !== "number" ||
          typeof token.chainId !== "number"
        ) continue;
        if (token.chainId !== chainId) continue;
        result.push({
          symbol: token.symbol.toUpperCase(),
          name: token.name,
          address: token.address,
          decimals: token.decimals,
          chainId: token.chainId,
          isNative: false,
          logoUri: typeof token.logoURI === "string" ? token.logoURI : null,
          deployerAddress: null,
        });
      }
      return result;
    } catch (err) {
      console.error("[PangolinTokenCrawler] fetch failed:", err);
      return [];
    }
  }
}
