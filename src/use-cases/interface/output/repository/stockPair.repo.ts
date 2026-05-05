/**
 * Output port — DB-backed registry of supported tokenized-stock pairs.
 *
 * Two upsert paths intentionally:
 *  - `upsertChainFields` is what the on-chain crawler calls; it MUST NOT
 *    overwrite the human-readable `name` if a row already exists, since the
 *    name comes from a different source (SEC EDGAR) and the chain only knows
 *    the ticker.
 *  - `upsertWithName` is what the SEC-EDGAR enrichment path calls when it
 *    has both a chain-derived row and a friendly company name to write.
 */
export interface IStockPairRecord {
  id: string;
  symbol: string;        // canonical ticker, uppercase, e.g. "AAPL"
  name: string;          // human-readable, e.g. "Apple Inc."
  chainId: number;
  pairBase: string;      // lowercase 0x… synthetic on-venue address
  isActive: boolean;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface StockPairChainFields {
  id: string;
  symbol: string;
  chainId: number;
  pairBase: string;
  isActive: boolean;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface StockPairFullInit extends StockPairChainFields {
  name: string;
}

export interface IStockPairDB {
  /**
   * Upsert chain-derived columns (pairBase, isActive). On conflict,
   * existing `name` is preserved — the crawler does not know the friendly
   * name. New rows insert with `name = symbol` as a placeholder; the
   * SEC-EDGAR enrichment pass overwrites it.
   */
  upsertChainFields(row: StockPairChainFields): Promise<void>;

  /** Update only the human-readable `name` for an existing row. No-op if missing. */
  setName(symbol: string, chainId: number, name: string): Promise<void>;

  findBySymbolAndChain(symbol: string, chainId: number): Promise<IStockPairRecord | undefined>;

  /** Free-text match against symbol OR name (case-insensitive substring). */
  searchByNameOrSymbol(query: string, chainId: number): Promise<IStockPairRecord[]>;

  listByChain(chainId: number): Promise<IStockPairRecord[]>;
}
