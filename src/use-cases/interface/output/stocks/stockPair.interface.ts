/**
 * Output port — registry of supported tokenized-stock symbols and their
 * synthetic on-venue `pairBase` addresses. Verified against the live
 * Aster Diamond at boot (soft-fail per the stocks plan, fix #9).
 */
export interface IStockPairRegistry {
  /** Resolve a stock symbol like "TSLA" to the on-venue synthetic pairBase address. */
  resolve(symbol: string): `0x${string}` | null;
  /** All supported symbols (uppercase). Stable order. */
  symbols(): readonly string[];
  /** All supported pairs as flat tuples (used by HTTP /stocks/pairs). */
  list(): ReadonlyArray<{ symbol: string; pairBase: `0x${string}` }>;
  /**
   * Verify the in-memory map against the live chain. Throws on mismatch.
   * Called once at boot from `AssistantInject.verifyStockCapability()`.
   * Throwing causes the soft-disable flag to flip on; the rest of the
   * backend keeps booting.
   */
  verifyAgainstChain(): Promise<void>;
}
