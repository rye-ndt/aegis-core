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
}
