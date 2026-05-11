/**
 * Canonical per-market structured fact. Phase 1 of the deterministic-detection
 * plan (`constructions/2026-05-11-prediction-markets-deterministic-detection-part2.md`).
 * The LLM extractor (Part 3) writes one `MarketFact` per market; the
 * deterministic clusterer (Part 4) and detector (Part 5) read these rows.
 * No callers in Part 2 — pure definitions.
 */
import type {
  ResolutionSourceCode,
  SubjectCode,
} from "./marketFactVocabularies";

export type Operator = "gte" | "lte" | "gt" | "lt" | "eq" | "in";

export type ThresholdUnit =
  | "USD"
  | "USD_PCT"
  | "BPS"
  | "COUNT"
  | "BOOL"
  | "CATEGORY";

export type ResolutionMethod =
  | "any_touch_during_window"
  | "close_at_window_end"
  | "twap_during_window"
  | "official_announcement"
  | "uma_optimistic_oracle"
  | "discrete_outcome_announcement";

export interface MarketFact {
  /** Polymarket condition_id; foreign key into snapshots / findings. */
  marketId: string;
  subject: SubjectCode;
  operator: Operator;
  /** Null when `operator === 'in'`; otherwise the scalar threshold. */
  threshold: number | string | null;
  /** Populated only when `operator === 'in'`. */
  thresholdSet: string[] | null;
  thresholdUnit: ThresholdUnit;
  /** Epoch seconds; null for open-ended "any time before" framings. */
  windowStart: number | null;
  /** Epoch seconds; MUST equal Polymarket endDate ±24h (extractor invariant). */
  windowEnd: number;
  resolutionSource: ResolutionSourceCode;
  resolutionMethod: ResolutionMethod;
  /** Derived via `canonicalEventFamily`; persisted so cluster reads are
   *  index-friendly. */
  eventFamily: string;
  polymarketEventId: string | null;
  extractionModel: string;
  extractionPromptVersion: string;
  extractionAtEpoch: number;
  /** False => row is in the review queue and MUST NOT enter the hot path. */
  regexVerified: boolean;
}

/**
 * Two facts with the same `eventFamily` are members of the same deterministic
 * cluster (Part 4). The `operator + threshold` defines their role within it.
 */
export function canonicalEventFamily(
  fact: Pick<MarketFact, "subject" | "windowStart" | "windowEnd" | "resolutionSource">,
): string {
  return `${fact.subject}::${fact.windowStart ?? 0}-${fact.windowEnd}::${fact.resolutionSource}`;
}
