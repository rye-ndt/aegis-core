/**
 * Output port — fetches the live list of supported stock/perp pairs from the
 * venue (Aster Diamond) and enriches each with a human-readable company name
 * (SEC EDGAR). The ingestion use case persists the result to `stock_pairs`.
 *
 * `name` is `undefined` when no friendly name source matched (e.g., crypto or
 * forex pairs Aster lists alongside stocks). The repo treats undefined as
 * "store the symbol as a placeholder name" so the row is still indexable but
 * resolveByQuery's natural-language match won't hit it.
 */
export interface StockPairCrawl {
  symbol: string;        // canonical ticker, uppercase
  pairBase: `0x${string}`;
  name?: string;
}

export interface IStockPairCrawler {
  fetchPairs(chainId: number): Promise<StockPairCrawl[]>;
}
