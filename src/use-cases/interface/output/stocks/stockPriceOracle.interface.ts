export interface StockMark {
  symbol: string;
  /** Mark price in human-readable USD (e.g. "189.42"). */
  priceUsd: string;
  /** Source-chain timestamp (epoch seconds) the price was observed at. */
  asOfEpoch: number;
}

export interface IStockPriceOracle {
  markPrice(symbol: string): Promise<StockMark>;
  markPrices(symbols: readonly string[]): Promise<StockMark[]>;
}
