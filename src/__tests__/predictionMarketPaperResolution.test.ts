/**
 * Unit tests for `PredictionMarketPaperResolutionUseCase`. Pure mocks — DB
 * integration is exercised through the Part 1 repo tests.
 *
 * Run:
 *   npx tsx --test src/__tests__/predictionMarketPaperResolution.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PredictionMarketPaperResolutionUseCase } from "../use-cases/implementations/predictionMarketPaperResolution.usecase";
import type { IPolymarketResolutionFetcher, MarketResolution } from "../use-cases/interface/predictionMarket/IPolymarketResolutionFetcher";
import type { IPredictionMarketPaperBetRepository } from "../use-cases/interface/predictionMarket/IPredictionMarketPaperBetRepository";
import type { PaperBet, PaperBetResolutionPatch } from "../use-cases/interface/predictionMarket/PaperBetTypes";

interface Mocks {
  paperBetRepo: IPredictionMarketPaperBetRepository;
  fetcher: IPolymarketResolutionFetcher;
  /** Captures all `resolveMany` invocations. */
  resolved: PaperBetResolutionPatch[][];
  /** Counts fetches by marketId for concurrency-budget assertions. */
  fetches: Record<string, number>;
}

function bet(overrides: Partial<PaperBet>): PaperBet {
  return {
    id: overrides.id ?? "bet-x",
    userId: "u",
    findingId: "f",
    clusterId: "c",
    marketId: overrides.marketId ?? "m",
    subject: null,
    side: overrides.side ?? "YES",
    stakeUsdcCents: overrides.stakeUsdcCents ?? 1000,
    entryPriceBps: overrides.entryPriceBps ?? 4500,
    sharesE6: overrides.sharesE6 ?? 22_222_222n,
    detectorSource: overrides.detectorSource ?? "deterministic",
    status: "open",
    outcome: null,
    payoutUsdcCents: null,
    realizedPnlUsdcCents: null,
    entryAt: new Date(),
    resolvedAt: null,
    ...overrides,
  };
}

function makeResolution(marketId: string, outcome: "YES" | "NO"): MarketResolution {
  return { marketId, outcome, resolvedAt: new Date(), source: "polymarket-gamma" };
}

function buildMocks(opts: {
  openMarketIds: string[];
  resolutions: Record<string, MarketResolution | null>;
  openBets: PaperBet[];
}): Mocks {
  const resolved: PaperBetResolutionPatch[][] = [];
  const fetches: Record<string, number> = {};

  const paperBetRepo: IPredictionMarketPaperBetRepository = {
    insert: async () => { throw new Error("not used"); },
    findById: async () => null,
    listByUser: async () => [],
    listOpenByMarkets: async (ids) =>
      opts.openBets.filter((b) => ids.includes(b.marketId)),
    listOpenMarketIds: async () => [...opts.openMarketIds],
    resolveMany: async (patches) => {
      resolved.push(patches);
      return patches.length;
    },
    aggregatePerformance: async () => [],
  };

  const fetcher: IPolymarketResolutionFetcher = {
    fetch: async (marketId) => {
      fetches[marketId] = (fetches[marketId] ?? 0) + 1;
      return opts.resolutions[marketId] ?? null;
    },
    fetchMany: async (marketIds) => {
      const out = [];
      for (const id of marketIds) {
        fetches[id] = (fetches[id] ?? 0) + 1;
        const r = opts.resolutions[id];
        if (r) out.push(r);
      }
      return out;
    },
  };

  return { paperBetRepo, fetcher, resolved, fetches };
}

const cfg = { batchSize: 50, concurrency: 5 };

test("4-bet fixture: pnl math is exact for both outcomes and detector sources", async () => {
  // Use $10 stake at price 0.10 → 100 shares (sharesE6 = 100_000_000) → $100 payout = 10_000c.
  // PnL win = 10_000 − 1_000 = +9_000c. Loss payout = 0, pnl = -1_000c.
  const winShares = 100_000_000n;
  const fixtures: PaperBet[] = [
    bet({ id: "det-win", marketId: "m1", side: "YES", stakeUsdcCents: 1000, sharesE6: winShares, detectorSource: "deterministic" }),
    bet({ id: "det-loss", marketId: "m2", side: "YES", stakeUsdcCents: 1000, sharesE6: winShares, detectorSource: "deterministic" }),
    bet({ id: "llm-win", marketId: "m3", side: "NO", stakeUsdcCents: 1000, sharesE6: winShares, detectorSource: "llm" }),
    bet({ id: "llm-loss", marketId: "m4", side: "NO", stakeUsdcCents: 1000, sharesE6: winShares, detectorSource: "llm" }),
  ];
  const m = buildMocks({
    openMarketIds: ["m1", "m2", "m3", "m4"],
    resolutions: {
      m1: makeResolution("m1", "YES"), // det-win wins
      m2: makeResolution("m2", "NO"),  // det-loss loses
      m3: makeResolution("m3", "NO"),  // llm-win wins
      m4: makeResolution("m4", "YES"), // llm-loss loses
    },
    openBets: fixtures,
  });
  const uc = new PredictionMarketPaperResolutionUseCase(m.paperBetRepo, m.fetcher, cfg);
  const out = await uc.tick("r1");

  assert.equal(out.checked, 4);
  assert.equal(out.resolved, 4);
  assert.equal(m.resolved.length, 1);
  const patches = new Map(m.resolved[0]!.map((p) => [p.id, p]));

  // Win expectations: payout = 10_000c, pnl = +9_000c.
  for (const id of ["det-win", "llm-win"]) {
    const p = patches.get(id);
    assert.ok(p, `missing patch ${id}`);
    assert.equal(p.payoutUsdcCents, 10_000);
    assert.equal(p.realizedPnlUsdcCents, 9_000);
  }
  // Loss expectations: payout = 0, pnl = -1_000c.
  for (const id of ["det-loss", "llm-loss"]) {
    const p = patches.get(id);
    assert.ok(p);
    assert.equal(p.payoutUsdcCents, 0);
    assert.equal(p.realizedPnlUsdcCents, -1_000);
  }
});

test("null resolution leaves bet open; only resolved markets generate patches", async () => {
  const fixtures: PaperBet[] = [
    bet({ id: "b1", marketId: "m1", side: "YES" }),
    bet({ id: "b2", marketId: "m2", side: "YES" }),
  ];
  const m = buildMocks({
    openMarketIds: ["m1", "m2"],
    resolutions: {
      m1: makeResolution("m1", "YES"),
      m2: null, // still open / disputed
    },
    openBets: fixtures,
  });
  const uc = new PredictionMarketPaperResolutionUseCase(m.paperBetRepo, m.fetcher, cfg);
  const out = await uc.tick("r2");

  assert.equal(out.checked, 2);
  assert.equal(out.resolved, 1);
  assert.equal(m.resolved[0]?.length, 1);
  assert.equal(m.resolved[0]?.[0]?.id, "b1");
});

test("no open bets short-circuits before fetching", async () => {
  const m = buildMocks({ openMarketIds: [], resolutions: {}, openBets: [] });
  const uc = new PredictionMarketPaperResolutionUseCase(m.paperBetRepo, m.fetcher, cfg);
  const out = await uc.tick("r3");
  assert.deepEqual(out, { checked: 0, resolved: 0 });
  assert.equal(Object.keys(m.fetches).length, 0);
  assert.equal(m.resolved.length, 0);
});

test("no resolutions this tick: skips resolveMany entirely", async () => {
  const m = buildMocks({
    openMarketIds: ["m1", "m2"],
    resolutions: { m1: null, m2: null },
    openBets: [bet({ marketId: "m1" })],
  });
  const uc = new PredictionMarketPaperResolutionUseCase(m.paperBetRepo, m.fetcher, cfg);
  const out = await uc.tick("r4");
  assert.equal(out.resolved, 0);
  assert.equal(m.resolved.length, 0);
});

test("batchSize caps the per-tick fetch fan-out", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
  const m = buildMocks({
    openMarketIds: ids,
    resolutions: Object.fromEntries(ids.map((id) => [id, null])),
    openBets: [],
  });
  const uc = new PredictionMarketPaperResolutionUseCase(m.paperBetRepo, m.fetcher, { batchSize: 3, concurrency: 5 });
  const out = await uc.tick("r5");
  assert.equal(out.checked, 3);
  assert.equal(Object.keys(m.fetches).length, 3);
});

test("BigInt path: very large sharesE6 doesn't overflow", async () => {
  // 100 trillion shares — well past JS safe-integer range pre-divide.
  const huge = 100_000_000_000_000_000_000n; // 1e20
  const fixture = bet({
    id: "big",
    marketId: "m-big",
    side: "YES",
    stakeUsdcCents: 1000,
    sharesE6: huge,
  });
  const m = buildMocks({
    openMarketIds: ["m-big"],
    resolutions: { "m-big": makeResolution("m-big", "YES") },
    openBets: [fixture],
  });
  const uc = new PredictionMarketPaperResolutionUseCase(m.paperBetRepo, m.fetcher, cfg);
  const out = await uc.tick("r6");
  assert.equal(out.resolved, 1);
  // payout = huge / 10_000 = 1e16. Number(BigInt(1e16)) is exact (≤ Number.MAX_SAFE_INTEGER).
  const p = m.resolved[0]?.[0];
  assert.ok(p);
  assert.equal(p.payoutUsdcCents, 10_000_000_000_000_000);
  assert.equal(p.realizedPnlUsdcCents, 10_000_000_000_000_000 - 1000);
});

test("multiple bets on the same market all resolve from one fetch", async () => {
  const fixtures: PaperBet[] = [
    bet({ id: "a", marketId: "m1", side: "YES", sharesE6: 100_000_000n, stakeUsdcCents: 1000 }),
    bet({ id: "b", marketId: "m1", side: "NO", sharesE6: 100_000_000n, stakeUsdcCents: 1000 }),
  ];
  const m = buildMocks({
    openMarketIds: ["m1"],
    resolutions: { m1: makeResolution("m1", "YES") },
    openBets: fixtures,
  });
  const uc = new PredictionMarketPaperResolutionUseCase(m.paperBetRepo, m.fetcher, cfg);
  await uc.tick("r7");
  assert.equal(m.fetches["m1"], 1, "market fetched exactly once");
  const patches = new Map(m.resolved[0]!.map((p) => [p.id, p]));
  assert.equal(patches.get("a")?.payoutUsdcCents, 10_000); // YES side wins
  assert.equal(patches.get("b")?.payoutUsdcCents, 0);       // NO side loses
});
