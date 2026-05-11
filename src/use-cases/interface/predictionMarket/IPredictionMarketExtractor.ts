import type { MarketFact } from "./MarketFactTypes";
import type { RawMarket } from "./PredictionMarketTypes";

export interface RegexFailure {
  field: string;
  reason: string;
}

export interface ExtractorInput {
  market: RawMarket;
  reqId: string;
}

export type ExtractorOutcome =
  | { kind: "verified"; fact: MarketFact }
  | { kind: "review"; proposedFact: MarketFact; regexFailures: RegexFailure[] }
  | { kind: "failed"; reason: string };

export interface IPredictionMarketExtractor {
  /**
   * Per-market structured extraction. The implementation calls the LLM,
   * stamps provenance fields, runs the regex verifier, and returns
   * `verified` (write to facts), `review` (write to review queue), or
   * `failed` (LLM/JSON failure; no row written).
   */
  extract(input: ExtractorInput): Promise<ExtractorOutcome>;
}
