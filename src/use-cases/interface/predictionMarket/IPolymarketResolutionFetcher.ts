/**
 * Resolution-lookup port for the paper-bet resolution job (Part 3).
 *
 * Kept separate from `IPolymarketAdapter` (which centres on order-book reads
 * and signed-order forwarding) so the adapter stays focused on the bet
 * pipeline. The resolution fetcher only needs Gamma — no CLOB, no L2 HMAC,
 * no signing — and only one method, so a thin standalone port is the right
 * shape.
 *
 * `outcome` mirrors the `PaperBetSide` enum in `PaperBetTypes.ts` (`'YES' | 'NO'`)
 * so a resolved bet's `outcome` field maps straight across.
 */

export interface MarketResolution {
  marketId: string;
  outcome: "YES" | "NO";
  /** Best-effort settlement timestamp from Gamma (`closedTime`/`endDate`). */
  resolvedAt: Date;
  source: "polymarket-gamma";
}

export interface IPolymarketResolutionFetcher {
  /**
   * Returns resolution if the market is settled with an unambiguous outcome.
   * Returns `null` for: still-open markets, in-dispute markets, ambiguous
   * outcome prices (e.g. `[0.5, 0.5]`), or any upstream error. Callers treat
   * `null` uniformly: leave the bet `open` for the next tick.
   *
   * Implementations log at `warn` when prices look degenerate so operators
   * can investigate, but never throw — a single bad market mustn't poison the
   * whole tick.
   */
  fetch(marketId: string): Promise<MarketResolution | null>;
  /**
   * Batched variant — Gamma's `/markets?condition_ids=…` accepts repeated
   * query params, so a 50-market tick can issue one HTTP call instead of 50.
   * Returns only the resolved markets; unresolved/ambiguous/missing rows are
   * silently dropped (same `null`-equivalent semantics as `fetch`).
   */
  fetchMany(marketIds: string[]): Promise<MarketResolution[]>;
}
