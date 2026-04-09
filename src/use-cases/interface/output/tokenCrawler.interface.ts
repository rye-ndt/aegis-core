export interface CrawledToken {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  chainId: number;
  isNative: boolean;
  logoUri?: string | null;
  deployerAddress?: string | null;
}

export interface ITokenCrawlerJob {
  /**
   * Fetch all tokens for the given chainId from the external source.
   * Returns an empty array (never throws) if the source is unreachable.
   */
  fetchTokens(chainId: number): Promise<CrawledToken[]>;
}
