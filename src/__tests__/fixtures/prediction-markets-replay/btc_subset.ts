/**
 * Synthetic subset / nested fixture: three BTC ≥ {90k, 95k, 100k} markets
 * resolving on the same date. P(≥100k) at 12% but P(≥95k) at 8% is impossible
 * (narrower priced above wider). Exercises the `subset` primitive.
 */
import type { MarketFact } from "../../../use-cases/interface/predictionMarket/MarketFactTypes";
import type { RawMarket, StoredCluster } from "../../../use-cases/interface/predictionMarket/PredictionMarketTypes";

const WINDOW_END = 1781827200; // 2026-06-30
const RUN_ID = "00000000-0000-0000-0000-000000000001";
const CLUSTER_ID = "00000000-0000-0000-0000-0000000000aa";

function market(id: string, yesPrice: number, question: string): RawMarket {
  return {
    marketId: id,
    slug: id,
    question,
    resolutionCriteria: "Coinbase BTC/USD close price as of 2026-06-30",
    category: "Crypto",
    resolutionEpochSec: WINDOW_END,
    yesPrice,
    noPrice: 1 - yesPrice,
    openInterestUsd: 250_000,
    volume7dUsd: 100_000,
    liquidityUsd: 150_000,
    isActive: true,
    isDisputed: false,
    outcomesCount: 2,
    url: `https://polymarket.com/${id}`,
    polymarketEventId: "btc-end-of-q2-2026",
  };
}

function fact(marketId: string, threshold: number): MarketFact {
  return {
    marketId,
    subject: "BTC_USD_SPOT",
    operator: "gte",
    threshold,
    thresholdSet: null,
    thresholdUnit: "USD",
    windowStart: null,
    windowEnd: WINDOW_END,
    resolutionSource: "COINBASE_PRO_USD",
    resolutionMethod: "close_at_window_end",
    eventFamily: `BTC_USD_SPOT::0-${WINDOW_END}::COINBASE_PRO_USD`,
    polymarketEventId: "btc-end-of-q2-2026",
    extractionModel: "fixture",
    extractionPromptVersion: "fixture",
    extractionAtEpoch: 0,
    regexVerified: true,
  };
}

export const fixture = {
  name: "btc_subset",
  runId: RUN_ID,
  cluster: {
    clusterId: CLUSTER_ID,
    runId: RUN_ID,
    theme: "BTC_USD_SPOT nested",
    causalDriver: "BTC_USD_SPOT",
    marketIds: ["btc-gte-90k", "btc-gte-95k", "btc-gte-100k"],
    expectedRelationships: [
      { kind: "nested" as const, description: "P(≥100k) ≤ P(≥95k) ≤ P(≥90k)" },
    ],
    rationale: "fixture",
    confidence: "high" as const,
    derivedSubject: "BTC_USD_SPOT",
  } satisfies StoredCluster,
  members: [
    market("btc-gte-90k", 0.30, "Will BTC be ≥ $90k by 2026-06-30?"),
    // 8% narrower priced ABOVE 95k at 12% — violation by 400 bps.
    market("btc-gte-95k", 0.08, "Will BTC be ≥ $95k by 2026-06-30?"),
    market("btc-gte-100k", 0.12, "Will BTC be ≥ $100k by 2026-06-30?"),
  ],
  facts: new Map<string, MarketFact>([
    ["btc-gte-90k", fact("btc-gte-90k", 90_000)],
    ["btc-gte-95k", fact("btc-gte-95k", 95_000)],
    ["btc-gte-100k", fact("btc-gte-100k", 100_000)],
  ]),
  /** Expected (pattern, sorted marketsInvolved, magnitudeBps ± 10bps). */
  expected: [
    {
      patternType: "logical_inconsistency",
      marketsInvolved: ["btc-gte-100k", "btc-gte-95k"],
      magnitudeBps: 400,
      widerMarketId: "btc-gte-95k",
      narrowerMarketId: "btc-gte-100k",
    },
  ],
};
