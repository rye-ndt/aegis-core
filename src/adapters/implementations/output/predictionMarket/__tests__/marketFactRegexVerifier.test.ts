/**
 * Unit tests for `marketFactRegexVerifier`. Phase 2 safety-net: every field
 * the LLM extracts has a regex sanity check; failures route the proposal to
 * the admin review queue instead of writing to `prediction_market_facts`.
 *
 * Run:
 *   npx tsx --test src/adapters/implementations/output/predictionMarket/__tests__/marketFactRegexVerifier.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyFact } from "../marketFactRegexVerifier";
import type { MarketFact } from "../../../../../use-cases/interface/predictionMarket/MarketFactTypes";
import type { RawMarket } from "../../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";

const WINDOW_END = 1781827200; // 2026-06-30

function market(overrides: Partial<RawMarket> = {}): RawMarket {
  return {
    marketId: "m1",
    slug: "m1",
    question: "Will BTC reach $95,000 by 2026-06-30 on Coinbase?",
    resolutionCriteria: "Resolves YES if BTC/USD on Coinbase reaches at least $95,000 by 2026-06-30 UTC.",
    category: "Crypto",
    resolutionEpochSec: WINDOW_END,
    yesPrice: 0.1,
    noPrice: 0.9,
    openInterestUsd: 100_000,
    volume7dUsd: 100_000,
    liquidityUsd: 100_000,
    isActive: true,
    isDisputed: false,
    outcomesCount: 2,
    url: "https://polymarket.com/m1",
    polymarketEventId: "evt-1",
    ...overrides,
  };
}

function fact(overrides: Partial<MarketFact> = {}): MarketFact {
  return {
    marketId: "m1",
    subject: "BTC_USD_SPOT",
    operator: "gte",
    threshold: 95_000,
    thresholdSet: null,
    thresholdUnit: "USD",
    windowStart: null,
    windowEnd: WINDOW_END,
    resolutionSource: "COINBASE_PRO_USD",
    resolutionMethod: "any_touch_during_window",
    eventFamily: "BTC_USD_SPOT::0-1781827200::COINBASE_PRO_USD",
    polymarketEventId: "evt-1",
    extractionModel: "test",
    extractionPromptVersion: "v1",
    extractionAtEpoch: 0,
    regexVerified: false,
    ...overrides,
  };
}

function fieldFailures(result: ReturnType<typeof verifyFact>): string[] {
  if (result.ok) return [];
  return result.failures.map((f) => f.field);
}

// ---- subject --------------------------------------------------------------

test("subject: in vocabulary passes (sanity)", () => {
  const r = verifyFact({ market: market(), proposed: fact() });
  assert.equal(r.ok, true);
});

test("subject: OTHER always forces review", () => {
  const r = verifyFact({
    market: market(),
    proposed: fact({ subject: "OTHER" as MarketFact["subject"] }),
  });
  assert.deepEqual(fieldFailures(r), ["subject"]);
});

test("subject: unknown code rejected", () => {
  const r = verifyFact({
    market: market(),
    proposed: fact({ subject: "GARBAGE" as MarketFact["subject"] }),
  });
  assert.ok(fieldFailures(r).includes("subject"));
});

// ---- threshold (numeric) --------------------------------------------------

test("threshold numeric: plain integer in title matches", () => {
  const r = verifyFact({ market: market(), proposed: fact({ threshold: 95_000 }) });
  assert.equal(r.ok, true);
});

test("threshold numeric: k-suffix matches '$95k'", () => {
  const r = verifyFact({
    market: market({ question: "Will BTC reach $95k by 2026-06-30 on Coinbase?" }),
    proposed: fact({ threshold: 95_000 }),
  });
  assert.equal(r.ok, true);
});

test("threshold numeric: missing from corpus fails", () => {
  const r = verifyFact({
    market: market({
      question: "Will BTC reach $80,000 by 2026-06-30 on Coinbase?",
      resolutionCriteria: "Resolves YES if BTC/USD reaches $80,000 on Coinbase by 2026-06-30.",
    }),
    proposed: fact({ threshold: 95_000 }),
  });
  assert.deepEqual(fieldFailures(r), ["threshold"]);
});

test("threshold null without operator='in' fails", () => {
  const r = verifyFact({ market: market(), proposed: fact({ threshold: null }) });
  assert.deepEqual(fieldFailures(r), ["threshold"]);
});

// ---- threshold (set, operator='in') --------------------------------------

test("thresholdSet: every member substring-present passes", () => {
  const r = verifyFact({
    market: market({
      question: "Which party wins the Senate seat: Republican, Democrat, or Independent?",
      resolutionCriteria: "Resolves to the elected party (Republican, Democrat, or Independent).",
    }),
    proposed: fact({
      subject: "US_SENATE_2026",
      operator: "in",
      threshold: null,
      thresholdSet: ["Republican", "Democrat", "Independent"],
      thresholdUnit: "CATEGORY",
      resolutionSource: "AP_CALL",
      eventFamily: "US_SENATE_2026::0-1781827200::AP_CALL",
    }),
  });
  // Operator keyword 'which' was tightened out; criteria contains 'one of' is
  // not present here, so operator check may still flag — accept either subset
  // by asserting threshold pass at minimum.
  const failed = fieldFailures(r);
  assert.ok(!failed.includes("thresholdSet"));
});

test("thresholdSet: missing member from corpus fails", () => {
  const r = verifyFact({
    market: market({
      question: "Which party wins: Republican or Democrat?",
      resolutionCriteria: "Either Republican or Democrat wins.",
    }),
    proposed: fact({
      operator: "in",
      threshold: null,
      thresholdSet: ["Republican", "Democrat", "Independent"],
      thresholdUnit: "CATEGORY",
    }),
  });
  assert.ok(fieldFailures(r).includes("thresholdSet"));
});

test("thresholdSet: empty / null for operator='in' fails", () => {
  const r = verifyFact({
    market: market(),
    proposed: fact({ operator: "in", threshold: null, thresholdSet: null }),
  });
  assert.ok(fieldFailures(r).includes("thresholdSet"));
});

// ---- windowEnd ------------------------------------------------------------

test("windowEnd within ±24h of resolutionEpochSec passes", () => {
  const r = verifyFact({
    market: market(),
    proposed: fact({ windowEnd: WINDOW_END + 60 * 60 }), // 1h after
  });
  assert.equal(r.ok, true);
});

test("windowEnd >24h drift fails", () => {
  const r = verifyFact({
    market: market(),
    proposed: fact({ windowEnd: WINDOW_END + 48 * 60 * 60 }), // 48h after
  });
  assert.ok(fieldFailures(r).includes("windowEnd"));
});

// ---- operator keyword -----------------------------------------------------

test("operator gte: 'reach' keyword matches", () => {
  const r = verifyFact({ market: market(), proposed: fact({ operator: "gte" }) });
  assert.equal(r.ok, true);
});

test("operator gte: title without any gte keyword fails", () => {
  const r = verifyFact({
    market: market({
      question: "Will BTC trade $95,000 on 2026-06-30 on Coinbase?",
      resolutionCriteria: "Reports the closing price ($95,000) on 2026-06-30 from Coinbase.",
    }),
    proposed: fact({ operator: "gte" }),
  });
  assert.ok(fieldFailures(r).includes("operator"));
});

test("operator eq: 'is' alone NO LONGER triggers (regex was tightened)", () => {
  // Why: prior regex `/\bis\b/` matched almost any sentence; now `eq` requires
  // 'equal(s)' / 'exactly' / '=='. A title that only says 'is' must fail.
  const r = verifyFact({
    market: market({
      question: "What is the unemployment rate in June 2026?",
      resolutionCriteria: "Resolves on the value reported by BLS for June 2026.",
    }),
    proposed: fact({
      operator: "eq",
      threshold: 4.2,
      thresholdUnit: "USD_PCT",
      resolutionSource: "BLS_OFFICIAL",
      subject: "CPI_YOY",
      windowEnd: WINDOW_END,
      eventFamily: "CPI_YOY::0-1781827200::BLS_OFFICIAL",
    }),
  });
  assert.ok(fieldFailures(r).includes("operator"));
});

test("operator eq: 'exactly 4.2%' triggers", () => {
  const r = verifyFact({
    market: market({
      question: "Will unemployment be exactly 4.2% in June 2026?",
      resolutionCriteria: "Resolves YES if BLS reports exactly 4.2% for June 2026.",
    }),
    proposed: fact({
      operator: "eq",
      threshold: 4.2,
      thresholdUnit: "USD_PCT",
      resolutionSource: "BLS_OFFICIAL",
      subject: "CPI_YOY",
      windowEnd: WINDOW_END,
      eventFamily: "CPI_YOY::0-1781827200::BLS_OFFICIAL",
    }),
  });
  const failed = fieldFailures(r);
  assert.ok(!failed.includes("operator"));
});

// ---- resolutionSource -----------------------------------------------------

test("resolutionSource: alias present in criteria passes", () => {
  const r = verifyFact({ market: market(), proposed: fact() });
  assert.equal(r.ok, true);
});

test("resolutionSource: alias missing fails", () => {
  const r = verifyFact({
    market: market({
      question: "Will BTC reach $95,000 by 2026-06-30?",
      resolutionCriteria: "Resolves YES if BTC/USD reaches at least $95,000 by 2026-06-30.",
    }),
    proposed: fact({ resolutionSource: "COINBASE_PRO_USD" }),
  });
  assert.ok(fieldFailures(r).includes("resolutionSource"));
});

test("resolutionSource: OTHER skips the alias check", () => {
  const r = verifyFact({
    market: market({
      resolutionCriteria: "Resolves YES if BTC reaches at least $95,000 by 2026-06-30.",
    }),
    proposed: fact({ resolutionSource: "OTHER" }),
  });
  // OTHER bypasses alias check; the proposal passes structurally though it'd
  // be sent to review for subject if the LLM chose OTHER for subject.
  const failed = fieldFailures(r);
  assert.ok(!failed.includes("resolutionSource"));
});

// ---- polymarketEventId mismatch ------------------------------------------

test("polymarketEventId: agreement passes", () => {
  const r = verifyFact({ market: market(), proposed: fact() });
  assert.equal(r.ok, true);
});

test("polymarketEventId: disagreement flagged", () => {
  const r = verifyFact({
    market: market({ polymarketEventId: "evt-1" }),
    proposed: fact({ polymarketEventId: "evt-2" }),
  });
  assert.ok(fieldFailures(r).includes("polymarketEventId"));
});

// ---- happy path: multi-failure aggregation -------------------------------

test("multiple failures are aggregated, not short-circuited", () => {
  const r = verifyFact({
    market: market({
      question: "Will Bitcoin trade $80,000 by 2026-06-30 on Coinbase?",
      resolutionCriteria: "Resolves on Bitcoin price at 80,000 USD by 2026-06-30 on Coinbase.",
    }),
    proposed: fact({
      threshold: 95_000,                  // mismatch
      operator: "eq",                     // no 'exactly' in corpus
      windowEnd: WINDOW_END + 72 * 3600,  // 72h drift
    }),
  });
  assert.equal(r.ok, false);
  const failed = fieldFailures(r);
  assert.ok(failed.includes("threshold"));
  assert.ok(failed.includes("operator"));
  assert.ok(failed.includes("windowEnd"));
});
