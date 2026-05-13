/**
 * Pg-backed repo tests for `DrizzlePredictionMarketPaperBetRepo`.
 *
 * Requires DATABASE_URL pointing at a database with `npm run db:migrate`
 * applied. Each test creates its own ephemeral user so writes don't bleed
 * across tests; the user FK cascades, so cleanup deletes the user row and the
 * inserted paper bets go with it.
 *
 * Run:
 *   DATABASE_URL=postgresql://… npx tsx --test src/__tests__/predictionMarketPaperBetRepo.test.ts
 */
import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";

import { DrizzlePredictionMarketPaperBetRepo } from "../adapters/implementations/output/sqlDB/repositories/predictionMarketPaperBet.repo";
import {
  predictionMarketClusters,
  predictionMarketFindings,
  predictionMarketRuns,
  users,
} from "../adapters/implementations/output/sqlDB/schema";
import type { PaperBetInsert } from "../use-cases/interface/predictionMarket/PaperBetTypes";

let pool: Pool;
let db: NodePgDatabase;
let repo: DrizzlePredictionMarketPaperBetRepo;

// Shared finding/cluster fixtures — paper-bet rows reference these via FK on
// `findingId` (no cascade), so they must outlive every test and be torn down
// in `after`.
const fixtureRunId = randomUUID();
const fixtureClusterDetId = randomUUID();
const fixtureClusterLlmId = randomUUID();
const fixtureFindingDetId = randomUUID();
const fixtureFindingLlmId = randomUUID();
const createdUserIds = new Set<string>();

before(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("DATABASE_URL is not set — required by paper-bet repo tests");
  pool = new Pool({ connectionString: cs });
  db = drizzle(pool);
  repo = new DrizzlePredictionMarketPaperBetRepo(db);

  const nowSec = Math.floor(Date.now() / 1000);
  await db.insert(predictionMarketRuns).values({
    runId: fixtureRunId,
    createdAtEpoch: nowSec,
    universeHash: "paper-bet-test-hash",
    status: "published",
    isLatest: false,
  });
  await db.insert(predictionMarketClusters).values([
    {
      clusterId: fixtureClusterDetId,
      runId: fixtureRunId,
      theme: "test-theme-det",
      causalDriver: "test",
      marketIds: ["m-det"],
      expectedRelationships: [],
      rationale: "test",
      confidence: "high",
      derivedSubject: "BTC_USD_SPOT",
    },
    {
      clusterId: fixtureClusterLlmId,
      runId: fixtureRunId,
      theme: "test-theme-llm",
      causalDriver: "test",
      marketIds: ["m-llm"],
      expectedRelationships: [],
      rationale: "test",
      confidence: "medium",
      derivedSubject: null,
    },
  ]);
  await db.insert(predictionMarketFindings).values([
    {
      findingId: fixtureFindingDetId,
      runId: fixtureRunId,
      clusterId: fixtureClusterDetId,
      patternType: "logical_inconsistency",
      marketsInvolved: ["m-det"],
      currentState: {},
      liveOdds: {},
      whyAnomalous: "test",
      sideA: {},
      sideB: {},
      confidence: "high",
      magnitudeBps: 250,
      rankScore: 1000,
      rationale: "test",
      createdAtEpoch: nowSec,
    },
    {
      findingId: fixtureFindingLlmId,
      runId: fixtureRunId,
      clusterId: fixtureClusterLlmId,
      patternType: "logical_inconsistency",
      marketsInvolved: ["m-llm"],
      currentState: {},
      liveOdds: {},
      whyAnomalous: "test",
      sideA: {},
      sideB: {},
      confidence: "medium",
      magnitudeBps: 150,
      rankScore: 500,
      rationale: "test",
      createdAtEpoch: nowSec,
    },
  ]);
});

after(async () => {
  // users.id has `onDelete: cascade` from paper_bets — wiping the user row
  // wipes every inserted bet for free.
  if (createdUserIds.size > 0) {
    await db.delete(users).where(inArray(users.id, [...createdUserIds]));
  }
  await db
    .delete(predictionMarketFindings)
    .where(eq(predictionMarketFindings.runId, fixtureRunId));
  await db
    .delete(predictionMarketClusters)
    .where(eq(predictionMarketClusters.runId, fixtureRunId));
  await db.delete(predictionMarketRuns).where(eq(predictionMarketRuns.runId, fixtureRunId));
  await pool.end();
});

async function newUser(): Promise<string> {
  const id = randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);
  await db.insert(users).values({
    id,
    userName: `paperbet-test-${id.slice(0, 8)}`,
    email: `paperbet-test-${id}@example.test`,
    status: "active",
    createdAtEpoch: nowSec,
    updatedAtEpoch: nowSec,
  });
  createdUserIds.add(id);
  return id;
}

function makeInsert(userId: string, overrides: Partial<PaperBetInsert> = {}): PaperBetInsert {
  return {
    userId,
    findingId: fixtureFindingDetId,
    clusterId: fixtureClusterDetId,
    marketId: "m-test",
    subject: "BTC_USD_SPOT",
    side: "YES",
    stakeUsdcCents: 1000,
    entryPriceBps: 4500,
    sharesE6: 2222222222n,
    detectorSource: "deterministic",
    ...overrides,
  };
}

test("insert + findById round-trip preserves bigint sharesE6", async () => {
  const userId = await newUser();
  const inserted = await repo.insert(makeInsert(userId, { sharesE6: 9999999999n }));
  assert.equal(typeof inserted.sharesE6, "bigint");
  assert.equal(inserted.sharesE6, 9999999999n);

  const found = await repo.findById(inserted.id);
  assert.ok(found);
  assert.equal(found.sharesE6, 9999999999n);
  assert.equal(found.userId, userId);
  assert.equal(found.status, "open");
  assert.equal(found.outcome, null);
  assert.equal(found.payoutUsdcCents, null);
  assert.equal(found.subject, "BTC_USD_SPOT");
});

test("resolveMany only flips open rows; second call is a no-op", async () => {
  const userId = await newUser();
  const a = await repo.insert(makeInsert(userId, { marketId: "m-resolve-a" }));
  const b = await repo.insert(makeInsert(userId, { marketId: "m-resolve-b" }));

  const n = await repo.resolveMany([
    { id: a.id, outcome: "YES", payoutUsdcCents: 2000, realizedPnlUsdcCents: 1000 },
    { id: b.id, outcome: "NO", payoutUsdcCents: 0, realizedPnlUsdcCents: -1000 },
  ]);
  assert.equal(n, 2);

  const aAfter = await repo.findById(a.id);
  assert.equal(aAfter?.status, "resolved");
  assert.equal(aAfter?.outcome, "YES");
  assert.equal(aAfter?.realizedPnlUsdcCents, 1000);
  assert.ok(aAfter?.resolvedAt instanceof Date);

  // Re-running a patch on an already-resolved row is a no-op.
  const nSecond = await repo.resolveMany([
    { id: a.id, outcome: "NO", payoutUsdcCents: 0, realizedPnlUsdcCents: -1000 },
  ]);
  assert.equal(nSecond, 0);
  const aReread = await repo.findById(a.id);
  assert.equal(aReread?.outcome, "YES");
  assert.equal(aReread?.realizedPnlUsdcCents, 1000);
});

test("aggregatePerformance(detectorSource) computes winRateBps and roiBps per slice", async () => {
  const userId = await newUser();
  // 1 win + 1 loss per detector source, equal stakes → ROI = 0, win-rate = 50%.
  const det1 = await repo.insert(
    makeInsert(userId, { marketId: "m-agg-det-win" }),
  );
  const det2 = await repo.insert(
    makeInsert(userId, { marketId: "m-agg-det-loss" }),
  );
  const llm1 = await repo.insert(
    makeInsert(userId, {
      marketId: "m-agg-llm-win",
      findingId: fixtureFindingLlmId,
      clusterId: fixtureClusterLlmId,
      subject: null,
      detectorSource: "llm",
    }),
  );
  const llm2 = await repo.insert(
    makeInsert(userId, {
      marketId: "m-agg-llm-loss",
      findingId: fixtureFindingLlmId,
      clusterId: fixtureClusterLlmId,
      subject: null,
      detectorSource: "llm",
    }),
  );

  await repo.resolveMany([
    { id: det1.id, outcome: "YES", payoutUsdcCents: 2000, realizedPnlUsdcCents: 1000 },
    { id: det2.id, outcome: "NO", payoutUsdcCents: 0, realizedPnlUsdcCents: -1000 },
    { id: llm1.id, outcome: "YES", payoutUsdcCents: 2000, realizedPnlUsdcCents: 1000 },
    { id: llm2.id, outcome: "NO", payoutUsdcCents: 0, realizedPnlUsdcCents: -1000 },
  ]);

  const buckets = await repo.aggregatePerformance({
    userId,
    groupBy: "detectorSource",
  });
  assert.equal(buckets.length, 2);
  for (const b of buckets) {
    assert.ok(b.key === "deterministic" || b.key === "llm", `unexpected key ${b.key}`);
    assert.equal(b.betCount, 2);
    assert.equal(b.wins, 1);
    assert.equal(b.losses, 1);
    assert.equal(b.winRateBps, 5000);
    assert.equal(b.totalStakeUsdcCents, 2000);
    assert.equal(b.totalPnlUsdcCents, 0);
    assert.equal(b.roiBps, 0);
  }
});

test("aggregatePerformance excludes open bets by default; widening status='open' surfaces them", async () => {
  const userId = await newUser();
  const open = await repo.insert(makeInsert(userId, { marketId: "m-still-open" }));
  const settled = await repo.insert(makeInsert(userId, { marketId: "m-settled" }));
  await repo.resolveMany([
    { id: settled.id, outcome: "YES", payoutUsdcCents: 2000, realizedPnlUsdcCents: 1000 },
  ]);

  const resolvedSlice = await repo.aggregatePerformance({ userId, groupBy: "overall" });
  assert.equal(resolvedSlice.length, 1);
  assert.equal(resolvedSlice[0]?.betCount, 1);
  assert.equal(resolvedSlice[0]?.totalStakeUsdcCents, 1000);
  assert.equal(resolvedSlice[0]?.totalPnlUsdcCents, 1000);

  const openSlice = await repo.aggregatePerformance({
    userId,
    groupBy: "overall",
    status: "open",
  });
  assert.equal(openSlice[0]?.betCount, 1);
  assert.equal(openSlice[0]?.totalStakeUsdcCents, 1000);

  // Sanity: subject grouping on the resolved slice surfaces the deterministic-subject bucket.
  const subjectSlice = await repo.aggregatePerformance({ userId, groupBy: "subject" });
  assert.equal(subjectSlice.length, 1);
  assert.equal(subjectSlice[0]?.key, "BTC_USD_SPOT");

  // Touch the open bet to silence "unused" lint and make intent explicit.
  assert.equal(open.status, "open");
});
