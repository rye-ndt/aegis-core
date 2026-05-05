/**
 * Output port — registry of supported tokenized-stock symbols and their
 * synthetic on-venue `pairBase` addresses.
 *
 * The DB-backed implementation keeps an in-memory snapshot for sync reads;
 * the snapshot is rebuilt by `refresh()` after every crawler tick.
 */
export interface IStockPairRegistry {
  /** Resolve a stock symbol like "TSLA" to the on-venue synthetic pairBase address. */
  resolve(symbol: string): `0x${string}` | null;
  /**
   * Free-text resolution. Hands back the canonical symbol when the input
   * matches a row's symbol (exact, case-insensitive) or company name (exact
   * word match preferred, substring fallback). Used by `/stock buy $5 of
   * apple` to map "apple" → "AAPL". Returns null when no row qualifies.
   */
  resolveByQuery(query: string): { symbol: string; pairBase: `0x${string}` } | null;
  /** All supported symbols (uppercase). Stable order. */
  symbols(): readonly string[];
  /** All supported pairs as flat tuples (used by HTTP /stocks/pairs). */
  list(): ReadonlyArray<{ symbol: string; pairBase: `0x${string}` }>;
  /**
   * Reload the in-memory snapshot from the DB. The crawler job invokes this
   * after every successful ingest tick. Soft-fails on DB errors — keeps the
   * previous snapshot in place.
   */
  refresh(): Promise<void>;
}
