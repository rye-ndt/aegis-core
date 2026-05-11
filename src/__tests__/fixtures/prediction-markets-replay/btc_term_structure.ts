/**
 * Synthetic term-structure fixture: two BTC ≥ $100k markets with different
 * resolution dates. Earlier window priced above later window violates temporal
 * nesting (later window is a superset of earlier). Exercises `temporal_nested`.
 */
import type { MarketFact } from "../../../use-cases/interface/predictionMarket/MarketFactTypes";
import type { RawMarket, StoredCluster } from "../../../use-cases/interface/predictionMarket/PredictionMarketTypes";

const EARLIER = 1779667200; // 2026-05-30
const LATER = 1781827200;   // 2026-06-30
const RUN_ID = "00000000-0000-0000-0000-000000000003";
const CLUSTER_ID = "00000000-0000-0000-0000-0000000000cc";
const EVENT = "btc-100k-term";

function market(id: string, yesPrice: number, resolveAt: number): RawMarket {
  return {
    marketId: id,
    slug: id,
    question: `Will BTC be ≥ $100k by ${new Date(resolveAt * 1000).toISOString().slice(0, 10)}?`,
    resolutionCriteria: "Coinbase BTC/USD close on date",
    category: "Crypto",
    resolutionEpochSec: resolveAt,
    yesPrice,
    noPrice: 1 - yesPrice,
    openInterestUsd: 250_000,
    volume7dUsd: 100_000,
    liquidityUsd: 150_000,
    isActive: true,
    isDisputed: false,
    outcomesCount: 2,
    url: `https://polymarket.com/${id}`,
    polymarketEventId: EVENT,
  };
}

function fact(marketId: string, windowEnd: number): MarketFact {
  return {
    marketId,
    subject: "BTC_USD_SPOT",
    operator: "gte",
    threshold: 100_000,
    thresholdSet: null,
    thresholdUnit: "USD",
    windowStart: null,
    windowEnd,
    resolutionSource: "COINBASE_PRO_USD",
    resolutionMethod: "close_at_window_end",
    eventFamily: `BTC_USD_SPOT::0-${windowEnd}::COINBASE_PRO_USD`,
    polymarketEventId: EVENT,
    extractionModel: "fixture",
    extractionPromptVersion: "fixture",
    extractionAtEpoch: 0,
    regexVerified: true,
  };
}

export const fixture = {
  name: "btc_term_structure",
  runId: RUN_ID,
  cluster: {
    clusterId: CLUSTER_ID,
    runId: RUN_ID,
    theme: "BTC_USD_SPOT term_structure",
    causalDriver: "BTC_USD_SPOT",
    marketIds: ["btc-100k-may", "btc-100k-jun"],
    expectedRelationships: [
      { kind: "term_structure" as const, description: "P(earlier) ≤ P(later)" },
    ],
    rationale: "fixture",
    confidence: "high" as const,
    derivedSubject: "BTC_USD_SPOT",
  } satisfies StoredCluster,
  members: [
    // 15% by May vs 8% by June — earlier above later by 700 bps.
    market("btc-100k-may", 0.15, EARLIER),
    market("btc-100k-jun", 0.08, LATER),
  ],
  facts: new Map<string, MarketFact>([
    ["btc-100k-may", fact("btc-100k-may", EARLIER)],
    ["btc-100k-jun", fact("btc-100k-jun", LATER)],
  ]),
  expected: [
    {
      patternType: "term_structure_anomaly",
      marketsInvolved: ["btc-100k-jun", "btc-100k-may"],
      magnitudeBps: 700,
      earlierMarketId: "btc-100k-may",
      laterMarketId: "btc-100k-jun",
    },
  ],
};
