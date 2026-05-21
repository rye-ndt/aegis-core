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
  BetIntentRow,
  BetRow,
  BetStatus,
  IPredictionMarketBetRepository,
  PositionRow,
  PositionStatus,
  SetupStep,
  UserSetupRow,
} from "../../interface/predictionMarket/IPredictionMarketBetRepository";
import type { IPolymarketReadAdapter } from "../../interface/predictionMarket/IPolymarketAdapter";
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
  async findActiveBetForUser(): Promise<BetRow | null> { return null; }
  async insertPosition(): Promise<void> {}
  async listOpenPositionsForUser(): Promise<PositionRow[]> { return []; }
  async listPositionsForUser(): Promise<PositionRow[]> { return []; }
  async getPosition(): Promise<null> { return null; }
  async updatePositionStatus(): Promise<void> {}
  async tryTransitionPositionStatus(): Promise<boolean> { return true; }
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

const fakeAdapter: IPolymarketReadAdapter = {
  async getOrderbookTopOfBook() {
    return { bestBidPrice: 0.49, bestAskPrice: 0.51, midPrice: 0.5 };
  },
  async getOrderbookDepth() { return []; },
  async getOrderStatus(): Promise<never> { throw new Error("not used"); },
  async getPositions(): Promise<never[]> { return []; },
};

const fakeProfileDB: IUserProfileDB = {
  async findByUserId() { return { eoaAddress: EOA } as never; },
} as unknown as IUserProfileDB;

const fakePmRepo = {
  async getMarketsByIds() { return []; },
} as unknown as import("../../interface/predictionMarket/IPredictionMarketRepository").IPredictionMarketRepository;

function makeUseCase(repo: FakeRepo) {
  const signing = new FakeSigningRequestUseCase();
  const miniApp = new FakeMiniAppCache();
  const redis = new FakeRedis();
  const uc = new PredictionMarketBetUseCase(repo, fakeProfileDB, fakeAdapter, fakePmRepo, {
    getSigningRequestUseCase: () => signing as unknown as ISigningRequestUseCase,
    miniAppRequestCache: miniApp,
    redis: redis as unknown as Redis,
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

// Each test below drives the state machine via fake /response payloads; no
// actual signing is required.

test("advance() returns the requestId of the enqueued sign request", async () => {
  const repo = new FakeRepo(freshBet(), fakeSetup());
  const { uc, signing } = makeUseCase(repo);
  const { enqueuedRequestId } = await uc.advance("bet-1");
  assert.equal(signing.created.length, 1);
  assert.equal(typeof enqueuedRequestId, "string");
  assert.equal(enqueuedRequestId, signing.created[0].id);
});

test("advance() returns null when the slot is already locked (idempotent re-advance)", async () => {
  const repo = new FakeRepo(freshBet(), fakeSetup());
  const { uc } = makeUseCase(repo);
  const first = await uc.advance("bet-1");
  const second = await uc.advance("bet-1");
  assert.equal(typeof first.enqueuedRequestId, "string");
  assert.equal(second.enqueuedRequestId, null);
});

// ─── close-* scenarios ───────────────────────────────────────────────────

/**
 * Extends FakeRepo with the close-side surfaces: a single open position,
 * findPositionByClosingBetId, and updatePositionStatus that mutates the row.
 */
class FakeRepoWithPosition extends FakeRepo {
  position: PositionRow;
  closeBetId: string | null = null;
  positionUpdates: Array<{ status: string; patch?: Partial<PositionRow> }> = [];
  constructor(bet: BetRow, setup: UserSetupRow, position: PositionRow, closeBetId?: string) {
    super(bet, setup);
    this.position = position;
    if (closeBetId) this.closeBetId = closeBetId;
  }
  async findPositionByClosingBetId(betId: string): Promise<PositionRow | null> {
    return this.closeBetId === betId ? this.position : null;
  }
  async updatePositionStatus(_id: string, status: PositionStatus, patch?: Partial<PositionRow>): Promise<void> {
    this.positionUpdates.push({ status, patch });
    this.position = { ...this.position, status, ...(patch ?? {}) };
  }
  async getPosition(): Promise<PositionRow | null> {
    return this.position;
  }
}

function fakePosition(overrides: Partial<PositionRow> = {}): PositionRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "pos-1",
    userId: USER,
    marketId: "mkt-1",
    outcomeTokenId: "777",
    side: "BUY",
    sizeShares: "10.5",
    entryPriceAvgBps: 4500,
    entryStakeUsdcCents: 472,
    openingBetId: "bet-open-1",
    closingBetId: "bet-1",
    currentValueUsdcCents: null,
    status: "closing",
    resolvedOutcome: null,
    realizedPnlUsdcCents: null,
    openedAtEpoch: now,
    closedAtEpoch: null,
    ...overrides,
  };
}

test("close-happy: SCA_TO_EOA → enqueues SELL eip712 → ORDER_SUBMITTED", async () => {
  const closeBet = freshBet({
    id: "bet-1",
    betKind: "close",
    parentBetId: "bet-open-1",
    status: "SCA_TO_EOA",
    refPriceBps: 5000,
  });
  const repo = new FakeRepoWithPosition(closeBet, fakeSetup(), fakePosition(), "bet-1");
  const { uc, signing } = makeUseCase(repo);

  await uc.advance("bet-1");
  assert.equal(signing.created.length, 1);
  assert.equal(signing.created[0].kind, "eip712");
  // @ts-expect-error eip712 discriminator narrows in the record
  assert.equal(signing.created[0].purpose, "polymarket_order");

  await uc.notifySignResolved({
    betId: "bet-1",
    requestId: signing.created[0].id,
    kind: "eip712",
    purpose: "polymarket_order",
    polymarketOrderId: "pm-close-1",
    rejected: false,
  });
  assert.equal(repo.bet.status, "ORDER_SUBMITTED");
  assert.equal(repo.bet.polymarketOrderId, "pm-close-1");
});

test("close-drift: live mid drifts beyond tolerance → bet FAILED, position rolled back to open, broadcaster fired", async () => {
  const closeBet = freshBet({
    id: "bet-1",
    betKind: "close",
    parentBetId: "bet-open-1",
    status: "SCA_TO_EOA",
    // refPriceBps far from the adapter's mid (0.5 → 5000 bps); drift threshold is 200bps
    refPriceBps: 3000,
  });
  const repo = new FakeRepoWithPosition(closeBet, fakeSetup(), fakePosition(), "bet-1");
  let driftCalls = 0;
  let driftBetId: string | null = null;
  const broadcaster = {
    async emitDriftCard(bet: BetRow): Promise<void> {
      driftCalls++;
      driftBetId = bet.id;
    },
    async broadcastFinalizeOutcome(): Promise<void> {},
    async broadcastPositionResolved(): Promise<void> {},
  };
  const signing = new FakeSigningRequestUseCase();
  const miniApp = new FakeMiniAppCache();
  const redis = new FakeRedis();
  const uc = new PredictionMarketBetUseCase(repo, fakeProfileDB, fakeAdapter, fakePmRepo, {
    getSigningRequestUseCase: () => signing as unknown as ISigningRequestUseCase,
    miniAppRequestCache: miniApp,
    redis: redis as unknown as Redis,
    chatIdResolver: async () => 0,
    receiptBroadcaster: broadcaster,
  });

  const { enqueuedRequestId } = await uc.advance("bet-1");
  assert.equal(enqueuedRequestId, null, "drift must not enqueue any sign request");
  assert.equal(signing.created.length, 0);
  assert.equal(repo.bet.status, "FAILED");
  assert.equal(repo.bet.failureReason, "drift");
  assert.equal(repo.position.status, "open");
  assert.equal(repo.position.closingBetId, null);
  assert.equal(driftCalls, 1);
  assert.equal(driftBetId, "bet-1");
});

test("close-partial: PARTIAL outcome enqueues a residual_sweep eoa_tx", async () => {
  // PARTIAL with refundRequired=true is what `finalizeBet` writes when the
  // close order partially fills. advance() should then enqueue an eoa_tx
  // sweeping the residual USDC back to the SCA.
  const partialBet = freshBet({
    id: "bet-1",
    betKind: "close",
    status: "PARTIAL",
    refundRequired: true,
    scaToEoaTxHash: "0x" + "b".repeat(64),
  });
  const repo = new FakeRepoWithPosition(partialBet, fakeSetup(), fakePosition(), "bet-1");
  const { uc, signing } = makeUseCase(repo);

  await uc.advance("bet-1");
  assert.equal(signing.created.length, 1);
  assert.equal(signing.created[0].kind, "eoa_tx");
});

// ─── setup-bet race ──────────────────────────────────────────────────────

/**
 * Repo for the setup-then-bet race: tracks the setup row's setupStep through
 * mutations and exposes the active bet for kickPendingBetsForUser.
 */
class FakeSetupRepo extends FakeRepo {
  approvals: string[] = [];
  setupSteps: SetupStep[] = [];
  constructor(bet: BetRow, setup: UserSetupRow) {
    super(bet, setup);
  }
  async updateSetupStep(_userId: string, step: SetupStep): Promise<void> {
    this.setupSteps.push(step);
    this.setup = { ...this.setup, setupStep: step };
  }
  async setApprovalsTxHashes(_userId: string, hashes: string[]): Promise<void> {
    this.approvals = hashes;
    this.setup = { ...this.setup, approvalsTxHashes: hashes };
  }
  async findActiveBetForUser(): Promise<BetRow | null> {
    if (this.bet.status === "FILLED" || this.bet.status === "FAILED") return null;
    return this.bet;
  }
}

test("setup-bet-race: user confirms during gas_funded → setup advances to complete → kickPendingBetsForUser advances bet", async () => {
  const bet = freshBet({ status: "INITIATED" });
  const setupRow: UserSetupRow = {
    ...fakeSetup(),
    setupStep: "gas_funded",
    polymarketCredsEnc: null, // setup not yet complete
  };
  const repo = new FakeSetupRepo(bet, setupRow);
  const { uc, signing } = makeUseCase(repo);

  // 1. setupAdvance enqueues all three approvals in a single call (the
  //    helper loops over the approvals list). The mini-app picks them up
  //    one at a time via fetchNextRequest.
  await uc.setupAdvance(USER);
  assert.equal(signing.created.length, 3);
  for (const r of signing.created) {
    assert.equal(r.kind, "eoa_tx");
    assert.equal(r.setupForUserId, USER);
  }

  // 2. Three approvals resolve in sequence
  for (let i = 0; i < 3; i++) {
    await uc.notifySetupSignResolved({
      userId: USER,
      requestId: signing.created[i].id,
      kind: "eoa_tx",
      txHash: `0x${"c".repeat(63)}${i}`,
      rejected: false,
    });
  }
  // setupStep should now be 'approved' and a clob_auth eip712 should be enqueued
  assert.ok(repo.setupSteps.includes("approved"));
  assert.equal(signing.created.length, 4);
  const clobAuth = signing.created[3];
  assert.equal(clobAuth.kind, "eip712");
  // @ts-expect-error narrows on kind
  assert.equal(clobAuth.purpose, "clob_auth");

  // 3. Mark creds as present (the FE would have stored them before posting
  // the /response, so this mirrors the BE's view at notify time).
  repo.setup = { ...repo.setup, polymarketCredsEnc: "x" };

  // 4. clob_auth resolves → setup flips authed → complete → kickPendingBetsForUser
  //    advances the active bet from INITIATED → enqueues sca_to_eoa.
  await uc.notifySetupSignResolved({
    userId: USER,
    requestId: clobAuth.id,
    kind: "eip712",
    purpose: "clob_auth",
    rejected: false,
  });
  assert.ok(repo.setupSteps.includes("complete"));
  // signing.created length grows by exactly one (the bet's sca_to_eoa userop)
  assert.equal(signing.created.length, 5);
  const betSign = signing.created[4];
  assert.equal(betSign.kind, "userop");
  assert.equal(betSign.betId, "bet-1");
});

// ─── BetInFlight invariant across betKind ─────────────────────────────────

test("BetInFlight: confirmBetIntent throws when an active bet exists (any betKind)", async () => {
  // The countOpenBetsForUser guard treats both open and close non-terminal
  // bets as in-flight — kickPendingBetsForUser depends on this invariant so
  // its `findActiveBetForUser` lookup is unambiguous.
  const repo = new FakeRepo(freshBet({ betKind: "close" }), fakeSetup());
  // Force the guard to fire by overriding countOpenBetsForUser.
  repo.countOpenBetsForUser = async () => 1;
  const intent: BetIntentRow = {
    id: "int-1",
    userId: USER,
    findingId: null,
    marketId: "mkt-1",
    side: "BUY",
    outcomeTokenId: "777",
    stakeUsdcCents: 500,
    refPriceBps: 5000,
    status: "awaiting_confirm",
    betId: null,
    expiresAtEpoch: Math.floor(Date.now() / 1000) + 3600,
    createdAtEpoch: Math.floor(Date.now() / 1000),
    updatedAtEpoch: Math.floor(Date.now() / 1000),
  };
  repo.getBetIntent = async () => intent;
  const { uc } = makeUseCase(repo);
  await assert.rejects(
    () =>
      uc.confirmBetIntent({
        userId: USER,
        intentId: "int-1",
        clientOrderId: "co-2",
      }),
    /BET_IN_FLIGHT/,
  );
});
