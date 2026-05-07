import type { RawMarket } from "./PredictionMarketTypes";

export interface ProviderFilters {
  minOpenInterestUsd: number;
  minVolume7dUsd: number;
  minDaysToResolution: number;
  maxDaysToResolution: number;
  topN: number;
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
}
