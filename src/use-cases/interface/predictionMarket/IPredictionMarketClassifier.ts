import type { DraftCluster, RawMarket } from "./PredictionMarketTypes";

export interface ClassifierMarketRecord {
  marketId: string;
  question: string;
  resolutionCriteria: string;
  resolutionEpochSec: number;
  category: string | null;
}

export interface ClassifierInput {
  markets: ClassifierMarketRecord[];
  reqId: string;
}

export interface IPredictionMarketClassifier {
  classify(input: ClassifierInput): Promise<DraftCluster[]>;
}

export function toClassifierRecord(m: RawMarket): ClassifierMarketRecord {
  return {
    marketId: m.marketId,
    question: m.question,
    resolutionCriteria: m.resolutionCriteria,
    resolutionEpochSec: m.resolutionEpochSec,
    category: m.category,
  };
}
