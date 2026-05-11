/**
 * Run with:
 *   npx tsx --test src/adapters/implementations/output/predictionMarket/__tests__/analyticalPredictionMarketSizer.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AnalyticalPredictionMarketSizer } from "../analyticalPredictionMarketSizer";
import type {
  MarketOrderBook,
  PricedLevel,
  SizerInput,
} from "../../../../../use-cases/interface/predictionMarket/IPredictionMarketSizer";
import type { VerifiedFinding } from "../../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";

const sizer = new AnalyticalPredictionMarketSizer();

function level(p: number, s: number): PricedLevel {
  return { priceFraction: p, shares: s };
}

function book(opts: {
  yesAsk?: PricedLevel[];
  noAsk?: PricedLevel[];
}): MarketOrderBook {
  return {
    yesBids: [],
    yesAsks: opts.yesAsk ?? [],
    noBids: [],
    noAsks: opts.noAsk ?? [],
  };
}

function subsetFinding(): VerifiedFinding {
  return {
    findingId: "f1",
    runId: "r1",
    clusterId: "c1",
    verifiedAtEpoch: 0,
    liveOdds: { wider: 0.10, narrower: 0.20 },
    magnitudeBps: 1000,
    rankScore: 100,
    patternType: "logical_inconsistency",
    marketsInvolved: ["wider", "narrower"],
    currentState: { citedOdds: { wider: 0.10, narrower: 0.20 } },
    whyAnomalous: "fixture",
    sideA: { label: "wider YES", marketId: "wider", outcome: "YES", rationale: "" },
    sideB: { label: "narrower NO", marketId: "narrower", outcome: "NO", rationale: "" },
    confidence: "high",
    rationale: "fixture",
    widerMarketId: "wider",
    narrowerMarketId: "narrower",
  };
}

function partitionFinding(): VerifiedFinding {
  return {
    findingId: "f2",
    runId: "r1",
    clusterId: "c2",
    verifiedAtEpoch: 0,
    liveOdds: { a: 0.45, b: 0.35, c: 0.35 },
    magnitudeBps: 1500,
    rankScore: 100,
    patternType: "logical_inconsistency",
    marketsInvolved: ["a", "b", "c"],
    currentState: { citedOdds: { a: 0.45, b: 0.35, c: 0.35 } },
    whyAnomalous: "fixture",
    sideA: { label: "a NO", marketId: "a", outcome: "NO", rationale: "" },
    sideB: { label: "b NO", marketId: "b", outcome: "NO", rationale: "" },
    confidence: "high",
    rationale: "fixture",
  };
}

function defaultInput(finding: VerifiedFinding, orderBook: Record<string, MarketOrderBook>): SizerInput {
  return {
    finding,
    orderBook,
    budgetUsdc: 100,
    feeBps: 0,
    gasEstimateUsdc: 0,
    reqId: "test",
  };
}

test("subset: deep books → sized to budget, positive profit", async () => {
  // Wider YES @ 0.10, narrower NO @ 0.70 (i.e. narrower YES = 0.30 > wider 0.10).
  // Combined unit cost = 0.80. Budget 100 USDC → 125 shares cap, capped to depth 1000.
  // Unit profit each branch ≥ 0.20. Total min payoff = 125 × 0.20 = 25.
  const out = await sizer.size(defaultInput(subsetFinding(), {
    wider: book({ yesAsk: [level(0.10, 1000)] }),
    narrower: book({ noAsk: [level(0.70, 1000)] }),
  }));
  assert.equal(out.kind, "sized");
  if (out.kind !== "sized") return;
  assert.equal(out.trades.length, 2);
  assert.equal(out.trades[0]!.marketId, "wider");
  assert.equal(out.trades[0]!.outcome, "YES");
  assert.equal(out.trades[1]!.outcome, "NO");
  assert.ok(out.expectedProfitUsdc > 0);
  // 125 shares × 0.20 per-branch payoff, no fees, no gas.
  assert.ok(Math.abs(out.expectedProfitUsdc - 25) < 0.01, `profit drift ${out.expectedProfitUsdc}`);
});

test("subset: depth-thin book sizes down but stays profitable", async () => {
  // Only 5 shares available across the two sides — depth caps the trade.
  const out = await sizer.size(defaultInput(subsetFinding(), {
    wider: book({ yesAsk: [level(0.10, 5)] }),
    narrower: book({ noAsk: [level(0.70, 5)] }),
  }));
  assert.equal(out.kind, "sized");
  if (out.kind !== "sized") return;
  assert.equal(out.trades[0]!.shares, 5);
  assert.equal(out.trades[1]!.shares, 5);
  // 5 × 0.20 = 1.0 USDC profit.
  assert.ok(Math.abs(out.expectedProfitUsdc - 1) < 0.01);
});

test("subset: uneconomic after fees + gas", async () => {
  // Tiny gap (0.10 → 0.12 narrower); shares × 0.02 profit easily wiped by fees + gas.
  const finding = subsetFinding();
  finding.liveOdds = { wider: 0.10, narrower: 0.12 };
  const out = await sizer.size({
    finding,
    orderBook: {
      wider: book({ yesAsk: [level(0.10, 50)] }),
      narrower: book({ noAsk: [level(0.88, 50)] }),
    },
    budgetUsdc: 100,
    feeBps: 200,
    gasEstimateUsdc: 5,
    reqId: "test",
  });
  assert.equal(out.kind, "uneconomic");
});

test("subset: multi-level book respects budget cap (no overshoot)", async () => {
  // Top tranche (cheap) is shallow; deeper tranche is more expensive. Prior
  // top-of-book heuristic would have bought past the budget.
  const out = await sizer.size({
    finding: subsetFinding(),
    orderBook: {
      wider: book({ yesAsk: [level(0.10, 5), level(0.20, 1000)] }),
      narrower: book({ noAsk: [level(0.70, 5), level(0.80, 1000)] }),
    },
    budgetUsdc: 50,
    feeBps: 0,
    gasEstimateUsdc: 0,
    reqId: "test",
  });
  assert.equal(out.kind, "sized");
  if (out.kind !== "sized") return;
  const gross = out.trades.reduce((acc, t) => acc + t.shares * t.avgPriceFraction, 0);
  assert.ok(gross <= 50 + 1e-6, `budget overshoot: gross=${gross}`);
});

test("subset: no arb at top of book → uneconomic", async () => {
  const out = await sizer.size(defaultInput(subsetFinding(), {
    wider: book({ yesAsk: [level(0.60, 100)] }),
    narrower: book({ noAsk: [level(0.50, 100)] }),
  }));
  assert.equal(out.kind, "uneconomic");
});

test("partition: 3-way over-priced → BUY NO on all, profit = (Σ p − 1) × shares", async () => {
  // YES prices 0.45 + 0.35 + 0.35 = 1.15 → NO prices 0.55 + 0.65 + 0.65 = 1.85.
  // 3 markets, total NO cost / unit = 1.85 < N − 1 = 2 → arb.
  // Per-unit profit = (N−1) − Σ NO = 2 − 1.85 = 0.15.
  const out = await sizer.size(defaultInput(partitionFinding(), {
    a: book({ noAsk: [level(0.55, 1000)] }),
    b: book({ noAsk: [level(0.65, 1000)] }),
    c: book({ noAsk: [level(0.65, 1000)] }),
  }));
  assert.equal(out.kind, "sized");
  if (out.kind !== "sized") return;
  assert.equal(out.trades.length, 3);
  for (const t of out.trades) assert.equal(t.outcome, "NO");
  // Budget 100 / 1.85 ≈ 54.05 shares, profit ≈ 54.05 × 0.15 = 8.11.
  assert.ok(Math.abs(out.expectedProfitUsdc - 8.11) < 0.05, `profit drift ${out.expectedProfitUsdc}`);
});

test("partition: not arb when sum NO ≥ N − 1", async () => {
  const out = await sizer.size(defaultInput(partitionFinding(), {
    a: book({ noAsk: [level(0.70, 1000)] }),
    b: book({ noAsk: [level(0.70, 1000)] }),
    c: book({ noAsk: [level(0.70, 1000)] }),
  }));
  assert.equal(out.kind, "uneconomic");
});

test("missing-order-book → uneconomic", async () => {
  const out = await sizer.size(defaultInput(subsetFinding(), {
    wider: book({ yesAsk: [level(0.10, 100)] }),
    // narrower book missing
  }));
  assert.equal(out.kind, "uneconomic");
});

test("unsupported pattern (no role tags) → uneconomic", async () => {
  const finding = subsetFinding();
  delete finding.widerMarketId;
  delete finding.narrowerMarketId;
  finding.marketsInvolved = ["a", "b"];
  const out = await sizer.size(defaultInput(finding, {}));
  assert.equal(out.kind, "uneconomic");
});
