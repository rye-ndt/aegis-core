import type { RawMarket } from "./PredictionMarketTypes";

export interface ProviderFilters {
  minOpenInterestUsd: number;
  minVolume7dUsd: number;
  minDaysToResolution: number;
  maxDaysToResolution: number;
  topN: number;
}

export interface OutcomeTokenPair {
  yes: string;
  no: string;
}

export interface IPredictionMarketProvider {
  fetchFiltered(filters: ProviderFilters, reqId: string): Promise<RawMarket[]>;
  /**
   * Re-fetch a small set of markets by canonical id (Polymarket condition_id).
   * Used by stage-3 verification to confirm drafts against fresh prices —
   * does not apply universe filters. Caller is responsible for batching;
   * the implementation chunks internally if its upstream is bounded.
   */
  fetchByIds(ids: string[], reqId: string): Promise<RawMarket[]>;
  /**
   * Sync lookup for `(marketId) → {yes, no}` outcome token ids. Populated as
   * a side effect of `fetchFiltered`/`fetchByIds`, which parse Gamma's
   * `clobTokenIds` field. Returns null when the market hasn't been fetched in
   * this process or the upstream didn't include token ids.
   *
   * Used by the analytical sizer (Part 6) — when this returns null the sizer
   * falls back to un-sized (the finding still broadcasts, just without a
   * profit estimate).
   */
  getOutcomeTokens(marketId: string): OutcomeTokenPair | null;
}
