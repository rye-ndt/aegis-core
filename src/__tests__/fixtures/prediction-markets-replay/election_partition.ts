/**
 * Synthetic partition (mutually-exclusive) fixture: 2028 US Pres four-way
 * race where YES prices sum to 1.15 — over-prices the partition by 1500 bps.
 * Exercises the `partition_exhaustive` primitive (falls back to non-exhaustive
 * if the exhaustive primitive returns null, per detector logic).
 */
import type { MarketFact } from "../../../use-cases/interface/predictionMarket/MarketFactTypes";
import type { RawMarket, StoredCluster } from "../../../use-cases/interface/predictionMarket/PredictionMarketTypes";

const WINDOW_END = 1856217600; // 2028-11-07
const RUN_ID = "00000000-0000-0000-0000-000000000002";
const CLUSTER_ID = "00000000-0000-0000-0000-0000000000bb";
const EVENT = "us-pres-2028";

function market(id: string, yesPrice: number, candidate: string, liquidity: number): RawMarket {
  return {
    marketId: id,
    slug: id,
    question: `Will ${candidate} win the 2028 US Presidential election?`,
    resolutionCriteria: "AP race call on 2028-11-07",
    category: "Politics",
    resolutionEpochSec: WINDOW_END,
    yesPrice,
    noPrice: 1 - yesPrice,
    openInterestUsd: 500_000,
    volume7dUsd: 200_000,
    liquidityUsd: liquidity,
    isActive: true,
    isDisputed: false,
    outcomesCount: 2,
    url: `https://polymarket.com/${id}`,
    polymarketEventId: EVENT,
  };
}

function fact(marketId: string, candidate: string): MarketFact {
  return {
    marketId,
    subject: "US_PRES_2028",
    operator: "in",
    threshold: null,
    thresholdSet: [candidate],
    thresholdUnit: "CATEGORY",
    windowStart: null,
    windowEnd: WINDOW_END,
    resolutionSource: "AP_CALL",
    resolutionMethod: "discrete_outcome_announcement",
    eventFamily: `US_PRES_2028::0-${WINDOW_END}::AP_CALL`,
    polymarketEventId: EVENT,
    extractionModel: "fixture",
    extractionPromptVersion: "fixture",
    extractionAtEpoch: 0,
    regexVerified: true,
  };
}

export const fixture = {
  name: "election_partition",
  runId: RUN_ID,
  cluster: {
    clusterId: CLUSTER_ID,
    runId: RUN_ID,
    theme: "US_PRES_2028 mutually_exclusive",
    causalDriver: "US_PRES_2028",
    marketIds: ["pres-A", "pres-B", "pres-C", "pres-D"],
    expectedRelationships: [
      { kind: "mutually_exclusive" as const, description: "Σ P(winner) ≤ 1" },
    ],
    rationale: "fixture",
    confidence: "high" as const,
    derivedSubject: "US_PRES_2028",
  } satisfies StoredCluster,
  members: [
    // 0.45 + 0.35 + 0.20 + 0.15 = 1.15 → 1500 bps over.
    market("pres-A", 0.45, "Candidate A", 400_000),
    market("pres-B", 0.35, "Candidate B", 300_000),
    market("pres-C", 0.20, "Candidate C", 200_000),
    market("pres-D", 0.15, "Candidate D", 100_000),
  ],
  facts: new Map<string, MarketFact>([
    ["pres-A", fact("pres-A", "A")],
    ["pres-B", fact("pres-B", "B")],
    ["pres-C", fact("pres-C", "C")],
    ["pres-D", fact("pres-D", "D")],
  ]),
  expected: [
    {
      patternType: "logical_inconsistency",
      marketsInvolved: ["pres-A", "pres-B", "pres-C", "pres-D"],
      magnitudeBps: 1500,
    },
  ],
};
