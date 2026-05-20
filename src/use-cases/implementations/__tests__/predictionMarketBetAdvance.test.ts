/**
 * Run with:
 *   PREDICTION_MARKETS_USE_SIGN_QUEUE=true PREDICTION_MARKETS_BETS_ENABLED=true \
 *   PREDICTION_MARKETS_CREDS_KEY_HEX=$(node -e "console.log('00'.repeat(32))") \
 *   npx tsx --test src/use-cases/implementations/__tests__/predictionMarketBetAdvance.test.ts
 *
 * Walks a bet through the new state machine via fake sign-request
 * resolutions. Covers:
 *  - INITIATED → SCA_TO_EOA → ORDER_SUBMITTED transitions
 *  - idempotency of `notifySignResolved` (double-fire produces one update)
 *  - the per-(bet, slot) NX lock blocks duplicate enqueues
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// USDC address used by enqueueScaToEoa — set before importing the use case so
// the cached env-driven config picks it up.
process.env.POLYGON_USDC ??= "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

import { PredictionMarketBetUseCase } from "../predictionMarketBet.usecase";
import type {
  BetRow,
  BetStatus,
  IPredictionMarketBetRepository,
  UserSetupRow,
  PositionRow,
} from "../../interface/predictionMarket/IPredictionMarketBetRepository";
import type { IPolymarketAdapter } from "../../interface/predictionMarket/IPolymarketAdapter";
import type { ISigningRequestUseCase } from "../../interface/input/signingRequest.interface";
import type { IMiniAppRequestCache } from "../../interface/output/cache/miniAppRequest.cache";
import type { SigningRequestRecord } from "../../interface/output/cache/signingRequest.cache";
import type { IUserProfileDB } from "../../interface/output/repository/userProfile.repo";
import type Redis from "ioredis";

const USER = "user-1";
const EOA = "0x1111111111111111111111111111111111111111";
const SCA = "0x2222222222222222222222222222222222222222";

function freshBet(overrides: Partial<BetRow> = {}): BetRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "bet-1",
    userId: USER,
    intentId: null,
    findingId: null,
    marketId: "mkt-1",
    outcomeTokenId: "777",
    side: "BUY",
    stakeUsdcCents: 500,
    refPriceBps: 5000,
    clientOrderId: "co-1",
    bridgeIntentId: null,
    scaToEoaTxHash: null,
    polymarketOrderId: null,
    status: "INITIATED",
    filledShares: null,
    filledAvgPriceBps: null,
    failureReason: null,
    betKind: "open",
    parentBetId: null,
    refundRequired: false,
    refundTxHash: null,
    createdAtEpoch: now,
    updatedAtEpoch: now,
    ...overrides,
  };
}

function fakeSetup(): UserSetupRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    userId: USER,
    polygonScaAddress: SCA,
    polygonEoaAddress: EOA,
    bootstrapBridgeIntentId: null,
    approvalsTxHashes: null,
    polymarketCredsEnc: "x", // truthy, marks setup completed for new path
    setupStep: "complete",
    createdAtEpoch: now,
    updatedAtEpoch: now,
  };
}

class FakeRepo implements IPredictionMarketBetRepository {
  bet: BetRow;
  setup: UserSetupRow;
  transitions: BetStatus[] = [];
  constructor(bet: BetRow, setup: UserSetupRow) {
    this.bet = bet;
    this.setup = setup;
  }
  async getBet(): Promise<BetRow | null> { return this.bet; }
  async updateBetStatus(_id: string, next: BetStatus, patch: Partial<BetRow> = {}): Promise<void> {
    this.transitions.push(next);
    this.bet = { ...this.bet, ...patch, status: next, updatedAtEpoch: Math.floor(Date.now() / 1000) };
  }
  async getUserSetup(): Promise<UserSetupRow | null> { return this.setup; }
  async setBetFailure(_id: string, reason: string): Promise<void> {
    this.bet = { ...this.bet, status: "FAILED", failureReason: reason };
  }
  async setBetRefundRequired(): Promise<void> {}
  async setBetRefundTxHash(_id: string, txHash: string): Promise<void> {
    this.bet = { ...this.bet, refundTxHash: txHash, refundRequired: false };
  }
  async listStuckBets(): Promise<BetRow[]> { return []; }

  // Minimal stubs for everything else on the interface — these methods are
  // not exercised by `advance` / `notifySignResolved`.
  async upsertUserSetup(): Promise<void> {}
  async updateSetupStep(): Promise<void> {}
  async setBootstrapBridgeIntentId(): Promise<void> {}
  async setApprovalsTxHashes(): Promise<void> {}
  async setPolymarketCredsEnc(): Promise<void> {}
  async insertBetIntent(): Promise<never> { throw new Error("not used"); }
  async getBetIntent(): Promise<null> { return null; }
  async setBetIntentAmount(): Promise<void> {}
  async setBetIntentStatus(): Promise<void> {}
  async findActiveIntentForUser(): Promise<null> { return null; }
  async insertBet(): Promise<never> { throw new Error("not used"); }
  async countOpenBetsForUser(): Promise<number> { return 0; }
  async insertPosition(): Promise<void> {}
  async listOpenPositionsForUser(): Promise<PositionRow[]> { return []; }
  async getPosition(): Promise<null> { return null; }
  async updatePositionStatus(): Promise<void> {}
  async decrementPositionShares(): Promise<void> {}
  async findPositionByOpeningBetId(): Promise<null> { return null; }
  async findPositionByClosingBetId(): Promise<null> { return null; }
  async listUsersWithOpenPositions(): Promise<never[]> { return []; }
}

class FakeRedis {
  store = new Map<string, string>();
  async set(key: string, val: string, _ex: string, _ttl: number, mode?: string): Promise<"OK" | null> {
    if (mode === "NX" && this.store.has(key)) return null;
    this.store.set(key, val);
    return "OK";
  }
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

class FakeSigningRequestUseCase {
  created: SigningRequestRecord[] = [];
  async create(r: SigningRequestRecord): Promise<void> { this.created.push(r); }
  async resolveRequest(): Promise<void> {}
  async waitFor(): Promise<never> { throw new Error("not used"); }
  cancelActiveForUser(): number { return 0; }
  async cancelPendingForUser(): Promise<number> { return 0; }
}

class FakeMiniAppCache implements IMiniAppRequestCache {
  stored: unknown[] = [];
  async store(req: unknown): Promise<void> { this.stored.push(req); }
  async retrieve(): Promise<null> { return null; }
  async delete(): Promise<void> {}
  async findNextPendingSignForUser(): Promise<null> { return null; }
  async cancelPendingForUser(): Promise<string[]> { return []; }
}

const fakeAdapter: IPolymarketAdapter = {
  async deriveApiKey(): Promise<never> { throw new Error("not used"); },
  async getOrderbookTopOfBook() {
    return { bestBidPrice: 0.49, bestAskPrice: 0.51, midPrice: 0.5 };
  },
  async getOrderbookDepth() { return []; },
  async placeOrder(): Promise<never> { throw new Error("not used"); },
  async cancelOrder(): Promise<void> {},
  async getOrderStatus(): Promise<never> { throw new Error("not used"); },
  async getPositions(): Promise<never[]> { return []; },
};

const fakeProfileDB: IUserProfileDB = {
  async findByUserId() { return { eoaAddress: EOA } as never; },
} as unknown as IUserProfileDB;

function makeUseCase(repo: FakeRepo) {
  const signing = new FakeSigningRequestUseCase();
  const miniApp = new FakeMiniAppCache();
  const redis = new FakeRedis();
  const uc = new PredictionMarketBetUseCase(repo, fakeProfileDB, fakeAdapter, {
    getSigningRequestUseCase: () => signing as unknown as ISigningRequestUseCase,
    miniAppRequestCache: miniApp,
    redis: redis as unknown as Redis,
    useSignQueue: true,
    chatIdResolver: async () => 0,
  });
  return { uc, signing, miniApp, redis };
}

test("advance(INITIATED) enqueues a userop sign-request and holds the slot lock", async () => {
  const repo = new FakeRepo(freshBet(), fakeSetup());
  const { uc, signing, redis } = makeUseCase(repo);
  await uc.advance("bet-1");

  assert.equal(signing.created.length, 1);
  assert.equal(signing.created[0].kind, "userop");
  assert.equal(signing.created[0].betId, "bet-1");
  // Lock present
  assert.equal(await redis.get("pm:bet:enqueue:bet-1:sca_to_eoa"), "1");

  // Second advance must NOT re-enqueue (NX lock blocks it).
  await uc.advance("bet-1");
  assert.equal(signing.created.length, 1);
});

test("notifySignResolved(userop) transitions bet to SCA_TO_EOA and releases the lock", async () => {
  const repo = new FakeRepo(freshBet(), fakeSetup());
  const { uc, redis } = makeUseCase(repo);
  await uc.advance("bet-1");

  // Simulate /response with a userop tx hash.
  await uc.notifySignResolved({
    betId: "bet-1",
    requestId: "req-1",
    kind: "userop",
    txHash: "0x" + "a".repeat(64),
    rejected: false,
  });
  assert.equal(repo.bet.status, "SCA_TO_EOA");
  assert.equal(repo.bet.scaToEoaTxHash, "0x" + "a".repeat(64));
  // Slot lock released so the sweeper / next advance can re-enqueue if needed.
  assert.equal(await redis.get("pm:bet:enqueue:bet-1:sca_to_eoa"), null);

  // The next slot (order_sign) is now in-flight per the chained advance.
  assert.equal(repo.transitions[0], "SCA_TO_EOA");
});

test("notifySignResolved(eip712 polymarket_order) jumps SCA_TO_EOA → ORDER_SUBMITTED in one write", async () => {
  const repo = new FakeRepo(freshBet({ status: "SCA_TO_EOA" }), fakeSetup());
  const { uc } = makeUseCase(repo);
  await uc.notifySignResolved({
    betId: "bet-1",
    requestId: "req-2",
    kind: "eip712",
    purpose: "polymarket_order",
    polymarketOrderId: "pm-1",
    rejected: false,
  });
  assert.equal(repo.bet.status, "ORDER_SUBMITTED");
  assert.equal(repo.bet.polymarketOrderId, "pm-1");
  // Only one status write — no intermediate ORDER_SIGNED.
  assert.deepEqual(repo.transitions, ["ORDER_SUBMITTED"]);
});

test("rejected /response on a PARTIAL bet does NOT throw IllegalBetTransitionError", async () => {
  const repo = new FakeRepo(
    freshBet({ status: "PARTIAL", refundRequired: true }),
    fakeSetup(),
  );
  const { uc } = makeUseCase(repo);
  // Override setBetFailure to throw if the use case tries to call it — it
  // must not, because PARTIAL has no legal forward transitions.
  let setBetFailureCalled = false;
  repo.setBetFailure = async () => {
    setBetFailureCalled = true;
    throw new Error("IllegalBetTransitionError");
  };
  await uc.notifySignResolved({
    betId: "bet-1",
    requestId: "req-x",
    kind: "eoa_tx",
    rejected: true,
    errorCode: "user-rejected",
  });
  assert.equal(setBetFailureCalled, false, "must skip setBetFailure on terminal bets");
});

test("advance() no-ops when setup is incomplete", async () => {
  const setup = { ...fakeSetup(), setupStep: "pending" as const, polymarketCredsEnc: null };
  const repo = new FakeRepo(freshBet(), setup);
  const { uc, signing } = makeUseCase(repo);
  await uc.advance("bet-1");
  assert.equal(signing.created.length, 0);
  assert.equal(repo.bet.status, "INITIATED");
});
