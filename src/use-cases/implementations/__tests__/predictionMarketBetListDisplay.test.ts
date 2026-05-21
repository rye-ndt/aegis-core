/**
 * Run with:
 *   PREDICTION_MARKETS_USE_SIGN_QUEUE=true PREDICTION_MARKETS_BETS_ENABLED=true \
 *   PREDICTION_MARKETS_CREDS_KEY_HEX=$(node -e "console.log('00'.repeat(32))") \
 *   npx tsx --test src/use-cases/implementations/__tests__/predictionMarketBetListDisplay.test.ts
 *
 * Covers the FE-facing join:
 *  - `listOpenPositionsForDisplay` enriches PositionRow with marketQuestion + outcomeLabel
 *  - missing-market fallback ("Market #<id8>")
 *  - YES/NO mapping from `side` (case-insensitive)
 *  - status filter delegates `['open','closing']` to repo.listPositionsForUser
 *  - empty input short-circuits without calling getMarketsByIds
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POLYGON_USDC ??= "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

import { PredictionMarketBetUseCase } from "../predictionMarketBet.usecase";
import type {
  IPredictionMarketBetRepository,
  PositionRow,
  PositionStatus,
} from "../../interface/predictionMarket/IPredictionMarketBetRepository";
import type { IPredictionMarketRepository } from "../../interface/predictionMarket/IPredictionMarketRepository";
import type { IPolymarketReadAdapter } from "../../interface/predictionMarket/IPolymarketAdapter";
import type { IUserProfileDB } from "../../interface/output/repository/userProfile.repo";
import type { RawMarket } from "../../interface/predictionMarket/PredictionMarketTypes";

const USER = "user-1";

function pos(overrides: Partial<PositionRow>): PositionRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "pos-1",
    userId: USER,
    marketId: "mkt-1",
    outcomeTokenId: "777",
    side: "yes",
    sizeShares: "10",
    entryPriceAvgBps: 5000,
    entryStakeUsdcCents: 500,
    openingBetId: "bet-1",
    closingBetId: null,
    currentValueUsdcCents: 600,
    status: "open" as PositionStatus,
    resolvedOutcome: null,
    realizedPnlUsdcCents: null,
    openedAtEpoch: now,
    closedAtEpoch: null,
    ...overrides,
  };
}

function mkt(marketId: string, question: string): RawMarket {
  return {
    marketId,
    slug: marketId,
    question,
    resolutionCriteria: "",
    category: null,
    resolutionEpochSec: 0,
    yesPrice: 0.5,
    noPrice: 0.5,
    openInterestUsd: 0,
    volume7dUsd: 0,
    liquidityUsd: 0,
    isActive: true,
    isDisputed: false,
    outcomesCount: 2,
    url: "",
  };
}

class FakeRepo implements Partial<IPredictionMarketBetRepository> {
  listPositionsArgs: Array<{ userId: string; statuses: PositionStatus[] }> = [];
  legacyListCalls = 0;
  constructor(private readonly positions: PositionRow[]) {}
  async listPositionsForUser(userId: string, statuses: PositionStatus[]): Promise<PositionRow[]> {
    this.listPositionsArgs.push({ userId, statuses });
    return this.positions.filter((p) => statuses.includes(p.status));
  }
  async listOpenPositionsForUser(): Promise<PositionRow[]> {
    this.legacyListCalls++;
    return this.positions.filter((p) => p.status === "open");
  }
}

class FakePmRepo implements Partial<IPredictionMarketRepository> {
  getMarketsCalls: string[][] = [];
  constructor(private readonly markets: RawMarket[]) {}
  async getMarketsByIds(ids: string[]): Promise<RawMarket[]> {
    this.getMarketsCalls.push([...ids]);
    return this.markets.filter((m) => ids.includes(m.marketId));
  }
}

const noopAdapter: IPolymarketReadAdapter = {
  async getOrderbookTopOfBook() { return { bestBidPrice: 0.49, bestAskPrice: 0.51, midPrice: 0.5 }; },
  async getOrderbookDepth() { return []; },
  async getOrderStatus(): Promise<never> { throw new Error("not used"); },
  async getPositions(): Promise<never[]> { return []; },
};

const noopProfileDB = {} as unknown as IUserProfileDB;

function makeUc(repo: FakeRepo, pmRepo: FakePmRepo) {
  return new PredictionMarketBetUseCase(
    repo as unknown as IPredictionMarketBetRepository,
    noopProfileDB,
    noopAdapter,
    pmRepo as unknown as IPredictionMarketRepository,
  );
}

test("enriches YES/NO label + marketQuestion for binary positions", async () => {
  const repo = new FakeRepo([
    pos({ id: "p-yes", marketId: "m-a", side: "yes" }),
    pos({ id: "p-no", marketId: "m-b", side: "NO" }),
  ]);
  const pm = new FakePmRepo([mkt("m-a", "Will A?"), mkt("m-b", "Will B?")]);
  const uc = makeUc(repo, pm);

  const out = await uc.listOpenPositionsForDisplay(USER);

  assert.equal(out.length, 2);
  const a = out.find((p) => p.id === "p-yes")!;
  const b = out.find((p) => p.id === "p-no")!;
  assert.equal(a.outcomeLabel, "YES");
  assert.equal(a.marketQuestion, "Will A?");
  assert.equal(b.outcomeLabel, "NO");
  assert.equal(b.marketQuestion, "Will B?");
});

test("falls back to truncated marketId when market is missing from latest run", async () => {
  const repo = new FakeRepo([
    pos({ id: "p-orphan", marketId: "0123456789abcdef-deadbeef", side: "yes" }),
  ]);
  const pm = new FakePmRepo([]); // no markets in universe
  const uc = makeUc(repo, pm);

  const out = await uc.listOpenPositionsForDisplay(USER);

  assert.equal(out.length, 1);
  assert.equal(out[0]!.marketQuestion, "Market #01234567");
  assert.equal(out[0]!.outcomeLabel, "YES");
});

test("requests positions with both 'open' and 'closing' statuses", async () => {
  const repo = new FakeRepo([
    pos({ id: "p-open", status: "open", marketId: "m-a", side: "yes" }),
    pos({ id: "p-closing", status: "closing", marketId: "m-a", side: "no" }),
    pos({ id: "p-closed", status: "closed", marketId: "m-a", side: "yes" }),
  ]);
  const pm = new FakePmRepo([mkt("m-a", "Q?")]);
  const uc = makeUc(repo, pm);

  const out = await uc.listOpenPositionsForDisplay(USER);

  assert.deepEqual(repo.listPositionsArgs, [{ userId: USER, statuses: ["open", "closing"] }]);
  assert.equal(repo.legacyListCalls, 0, "must not call the open-only legacy method");
  assert.equal(out.length, 2);
  assert.deepEqual(new Set(out.map((p) => p.id)), new Set(["p-open", "p-closing"]));
});

test("dedupes marketIds before fetching markets", async () => {
  const repo = new FakeRepo([
    pos({ id: "p-1", marketId: "m-a", side: "yes" }),
    pos({ id: "p-2", marketId: "m-a", side: "no" }),
    pos({ id: "p-3", marketId: "m-b", side: "yes" }),
  ]);
  const pm = new FakePmRepo([mkt("m-a", "A?"), mkt("m-b", "B?")]);
  const uc = makeUc(repo, pm);

  await uc.listOpenPositionsForDisplay(USER);

  assert.equal(pm.getMarketsCalls.length, 1);
  assert.deepEqual([...pm.getMarketsCalls[0]!].sort(), ["m-a", "m-b"]);
});

test("empty positions short-circuit without fetching markets", async () => {
  const repo = new FakeRepo([]);
  const pm = new FakePmRepo([]);
  const uc = makeUc(repo, pm);

  const out = await uc.listOpenPositionsForDisplay(USER);

  assert.deepEqual(out, []);
  assert.equal(pm.getMarketsCalls.length, 0);
});

test("preserves all PositionRow fields on the enriched row", async () => {
  const original = pos({
    id: "p-1",
    marketId: "m-a",
    side: "yes",
    sizeShares: "12.345",
    entryPriceAvgBps: 4200,
    entryStakeUsdcCents: 5100,
    currentValueUsdcCents: 6300,
  });
  const repo = new FakeRepo([original]);
  const pm = new FakePmRepo([mkt("m-a", "Q?")]);
  const uc = makeUc(repo, pm);

  const out = await uc.listOpenPositionsForDisplay(USER);

  const r = out[0]!;
  assert.equal(r.id, original.id);
  assert.equal(r.sizeShares, original.sizeShares);
  assert.equal(r.entryPriceAvgBps, original.entryPriceAvgBps);
  assert.equal(r.entryStakeUsdcCents, original.entryStakeUsdcCents);
  assert.equal(r.currentValueUsdcCents, original.currentValueUsdcCents);
  assert.equal(r.outcomeTokenId, original.outcomeTokenId);
});
