/**
 * Unit tests for LoyaltyUseCaseImpl.
 * Run with: npx tsx --test tests/loyalty.usecase.test.ts
 *
 * No real DB or Redis — all dependencies are in-memory stubs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { LoyaltyUseCaseImpl } from "../src/use-cases/implementations/loyaltyUseCase";
import type {
  ILoyaltyRepository,
  LedgerEntry,
  LoyaltySeason,
  LoyaltyActionType,
} from "../src/use-cases/interface/output/repository/loyalty.repo";
import { LOYALTY_STATUSES } from "../src/helpers/enums/loyaltyStatuses.enum";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ACTIVE_SEASON: LoyaltySeason = {
  id: "season-0",
  name: "Season 0",
  startsAtEpoch: 0,
  endsAtEpoch: 9999999999,
  status: "active",
  formulaVersion: "v1",
  config: {
    globalMultiplier: 1,
    perActionCap: 10_000,
    dailyUserCap: null,
    actionBase: { swap_same_chain: 100 },
    actionMultiplier: { swap_same_chain: 1 },
    actionMinUsd: {},
    volume: { formula: "sqrt", divisor: 100 },
  },
};

const SWAP_ACTION: LoyaltyActionType = {
  id: "swap_same_chain",
  displayName: "Swap (same-chain)",
  defaultBase: 100n,
  isActive: true,
  createdAtEpoch: 0,
};

function makeLedgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "entry-1",
    userId: "user-1",
    seasonId: "season-0",
    actionType: "swap_same_chain",
    pointsRaw: 100n,
    intentExecutionId: null,
    externalRef: null,
    formulaVersion: "v1",
    computedFromJson: {},
    metadataJson: null,
    createdAtEpoch: 1000,
    ...overrides,
  };
}

// ── Stub repo ─────────────────────────────────────────────────────────────────

function makeRepo(overrides: Partial<ILoyaltyRepository> = {}): ILoyaltyRepository {
  return {
    getActiveSeason: async () => ACTIVE_SEASON,
    getActionType: async () => SWAP_ACTION,
    getUserLoyaltyStatus: async () => LOYALTY_STATUSES.NORMAL,
    getSumPointsToday: async () => 0n,
    findByIntentExecutionId: async () => null,
    insertLedgerEntry: async (input) => ({
      id: "new-entry",
      userId: input.userId,
      seasonId: input.seasonId,
      actionType: input.actionType,
      pointsRaw: input.pointsRaw,
      intentExecutionId: input.intentExecutionId,
      externalRef: input.externalRef,
      formulaVersion: input.formulaVersion,
      computedFromJson: input.computedFromJson as Record<string, unknown>,
      metadataJson: input.metadataJson as Record<string, unknown> | null,
      createdAtEpoch: Math.floor(Date.now() / 1000),
    }),
    getUserBalance: async () => 0n,
    getUserRank: async () => null,
    getLeaderboard: async () => [],
    getHistory: async () => [],
    ...overrides,
  };
}

function makeUseCase(repoOverrides: Partial<ILoyaltyRepository> = {}) {
  return new LoyaltyUseCaseImpl({
    repo: makeRepo(repoOverrides),
    redis: undefined,
    activeSeasonCacheTtlMs: 60_000,
    leaderboardCacheTtlMs: 30_000,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("awardPoints happy path returns ledger entry", async () => {
  const uc = makeUseCase();
  const result = await uc.awardPoints({ userId: "user-1", actionType: "swap_same_chain" });
  assert.ok(result !== null);
  assert.equal(result!.actionType, "swap_same_chain");
  assert.ok(result!.pointsRaw > 0n);
});

test("awardPoints returns null for FORBIDDEN user", async () => {
  const uc = makeUseCase({ getUserLoyaltyStatus: async () => LOYALTY_STATUSES.FORBIDDEN });
  const result = await uc.awardPoints({ userId: "user-1", actionType: "swap_same_chain" });
  assert.equal(result, null);
});

test("awardPoints returns null when no active season", async () => {
  const uc = makeUseCase({ getActiveSeason: async () => null });
  const result = await uc.awardPoints({ userId: "user-1", actionType: "swap_same_chain" });
  assert.equal(result, null);
});

test("awardPoints returns null for inactive action type", async () => {
  const uc = makeUseCase({
    getActionType: async () => ({ ...SWAP_ACTION, isActive: false }),
  });
  const result = await uc.awardPoints({ userId: "user-1", actionType: "swap_same_chain" });
  assert.equal(result, null);
});

test("awardPoints daily cap: returns null when cap already hit", async () => {
  const capConfig = {
    ...ACTIVE_SEASON.config,
    dailyUserCap: 100,
  };
  const uc = makeUseCase({
    getActiveSeason: async () => ({ ...ACTIVE_SEASON, config: capConfig }),
    getSumPointsToday: async () => 100n,
  });
  const result = await uc.awardPoints({ userId: "user-1", actionType: "swap_same_chain" });
  assert.equal(result, null);
});

test("awardPoints daily cap: clamps points to remaining cap", async () => {
  const capConfig = {
    ...ACTIVE_SEASON.config,
    dailyUserCap: 150,
  };
  let insertedPoints: bigint | undefined;
  const uc = makeUseCase({
    getActiveSeason: async () => ({ ...ACTIVE_SEASON, config: capConfig }),
    getSumPointsToday: async () => 100n,
    insertLedgerEntry: async (input) => {
      insertedPoints = input.pointsRaw;
      return makeLedgerEntry({ pointsRaw: input.pointsRaw });
    },
  });
  await uc.awardPoints({ userId: "user-1", actionType: "swap_same_chain" });
  assert.equal(insertedPoints, 50n);
});

test("awardPoints never throws — repository error returns null", async () => {
  const uc = makeUseCase({
    insertLedgerEntry: async () => { throw new Error("DB is down"); },
  });
  const result = await uc.awardPoints({ userId: "user-1", actionType: "swap_same_chain" });
  assert.equal(result, null);
});

test("getBalance returns zero for FLAGGED user", async () => {
  const uc = makeUseCase({
    getUserLoyaltyStatus: async () => LOYALTY_STATUSES.FLAGGED,
    getUserBalance: async () => 999n,
  });
  const balance = await uc.getBalance("user-1");
  assert.equal(balance.pointsTotal, 0n);
  assert.equal(balance.rank, null);
});

test("getBalance returns zero when no active season", async () => {
  const uc = makeUseCase({ getActiveSeason: async () => null });
  const balance = await uc.getBalance("user-1");
  assert.equal(balance.seasonId, "none");
  assert.equal(balance.pointsTotal, 0n);
});

test("getBalance returns actual balance for NORMAL user", async () => {
  const uc = makeUseCase({ getUserBalance: async () => 500n, getUserRank: async () => 3 });
  const balance = await uc.getBalance("user-1");
  assert.equal(balance.pointsTotal, 500n);
  assert.equal(balance.rank, 3);
  assert.equal(balance.seasonId, "season-0");
});

test("getHistory returns empty when no active season", async () => {
  const uc = makeUseCase({ getActiveSeason: async () => null });
  const history = await uc.getHistory("user-1", { limit: 5 });
  assert.deepEqual(history, []);
});

test("getLeaderboard returns entries from repo when no Redis", async () => {
  const fakeEntries = [{ userId: "user-1", pointsTotal: 500n, rank: 1 }];
  const uc = makeUseCase({ getLeaderboard: async () => fakeEntries });
  const { entries, seasonId } = await uc.getLeaderboard("season-0", 10);
  assert.equal(seasonId, "season-0");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.pointsTotal, 500n);
});

test("adjustPoints inserts entry with provided values", async () => {
  let captured: { pointsRaw: bigint; actionType: string } | undefined;
  const uc = makeUseCase({
    insertLedgerEntry: async (input) => {
      captured = { pointsRaw: input.pointsRaw, actionType: input.actionType };
      return makeLedgerEntry({ pointsRaw: input.pointsRaw, actionType: input.actionType });
    },
  });
  await uc.adjustPoints({
    userId: "user-1",
    seasonId: "season-0",
    actionType: "manual_adjust",
    pointsRaw: -50n,
  });
  assert.equal(captured?.actionType, "manual_adjust");
  assert.equal(captured?.pointsRaw, -50n);
});
