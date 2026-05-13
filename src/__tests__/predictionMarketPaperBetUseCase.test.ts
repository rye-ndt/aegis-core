/**
 * Unit tests for `PredictionMarketPaperBetUseCase`. Pure mocks — DB integration
 * is covered by `predictionMarketPaperBetRepo.test.ts` (Part 1).
 *
 * Run:
 *   npx tsx --test src/__tests__/predictionMarketPaperBetUseCase.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PredictionMarketPaperBetUseCase,
  PaperBetValidationError,
  PaperBetNotFoundError,
  PaperBetPriceUnavailableError,
  pickSideThesis,
  wireSideToSelector,
} from "../use-cases/implementations/predictionMarketPaperBet.usecase";
import type { IPolymarketAdapter, OrderbookTopOfBook } from "../use-cases/interface/predictionMarket/IPolymarketAdapter";
import type { IPredictionMarketProvider } from "../use-cases/interface/predictionMarket/IPredictionMarketProvider";
import type { IPredictionMarketRepository } from "../use-cases/interface/predictionMarket/IPredictionMarketRepository";
import type { IPredictionMarketPaperBetRepository } from "../use-cases/interface/predictionMarket/IPredictionMarketPaperBetRepository";
import type {
  PaperBet,
  PaperBetInsert,
} from "../use-cases/interface/predictionMarket/PaperBetTypes";
import type { SideThesis, StoredCluster, StoredFinding } from "../use-cases/interface/predictionMarket/PredictionMarketTypes";

// ── Fixtures ────────────────────────────────────────────────────────────────

const baseFinding = (overrides: Partial<StoredFinding> = {}): StoredFinding => ({
  findingId: "00000000-0000-0000-0000-000000000001",
  runId: "00000000-0000-0000-0000-000000000010",
  clusterId: "00000000-0000-0000-0000-000000000020",
  patternType: "logical_inconsistency",
  marketsInvolved: ["m-A", "m-B"],
  currentState: { citedOdds: {} },
  liveOdds: { "m-A": 0.45, "m-B": 0.55 },
  whyAnomalous: "test",
  sideA: { label: "A label", marketId: "m-A", outcome: "YES", rationale: "r-A" },
  sideB: { label: "B label", marketId: "m-B", outcome: "YES", rationale: "r-B" },
  confidence: "high",
  magnitudeBps: 250,
  rankScore: 1000,
  rationale: "test",
  verifiedAtEpoch: 1,
  createdAtEpoch: 1,
  broadcastedAtEpoch: null,
  ...overrides,
});

const deterministicCluster: StoredCluster = {
  clusterId: "00000000-0000-0000-0000-000000000020",
  runId: "00000000-0000-0000-0000-000000000010",
  theme: "btc",
  causalDriver: "btc-spot",
  marketIds: ["m-A", "m-B"],
  expectedRelationships: [],
  rationale: "test",
  confidence: "high",
  derivedSubject: "BTC_USD_SPOT",
};
const llmCluster: StoredCluster = { ...deterministicCluster, derivedSubject: null };

interface Mocks {
  paperBetRepo: IPredictionMarketPaperBetRepository;
  findingRepo: IPredictionMarketRepository;
  provider: IPredictionMarketProvider;
  polymarket: IPolymarketAdapter;
  inserts: PaperBetInsert[];
}

function buildMocks(opts: {
  finding?: StoredFinding | null;
  cluster?: StoredCluster | null;
  tokens?: { yes: string; no: string } | null;
  /** Returned by getOrderbookTopOfBook; defaults to a healthy 0.45 ask. */
  tob?: OrderbookTopOfBook;
  /** When true, fetchByIds populates tokens on second call (cold-cache path). */
  warmTokensOnFetch?: { yes: string; no: string };
} = {}): Mocks {
  const finding = opts.finding === undefined ? baseFinding() : opts.finding;
  const cluster = opts.cluster === undefined ? deterministicCluster : opts.cluster;
  let tokens = opts.tokens === undefined ? { yes: "tok-yes", no: "tok-no" } : opts.tokens;
  const tob: OrderbookTopOfBook = opts.tob ?? {
    bestBidPrice: 0.44,
    bestAskPrice: 0.45,
    midPrice: 0.445,
  };
  const inserts: PaperBetInsert[] = [];

  const paperBetRepo: IPredictionMarketPaperBetRepository = {
    insert: async (row) => {
      inserts.push(row);
      const out: PaperBet = {
        id: "00000000-0000-0000-0000-000000000099",
        userId: row.userId,
        findingId: row.findingId,
        clusterId: row.clusterId,
        marketId: row.marketId,
        subject: row.subject,
        side: row.side,
        stakeUsdcCents: row.stakeUsdcCents,
        entryPriceBps: row.entryPriceBps,
        sharesE6: row.sharesE6,
        detectorSource: row.detectorSource,
        status: "open",
        outcome: null,
        payoutUsdcCents: null,
        realizedPnlUsdcCents: null,
        entryAt: new Date(),
        resolvedAt: null,
      };
      return out;
    },
    findById: async () => null,
    listByUser: async () => [],
    listOpenByMarkets: async () => [],
    listOpenMarketIds: async () => [],
    resolveMany: async () => 0,
    aggregatePerformance: async () => [],
  };

  const findingRepo = {
    getFinding: async () => finding,
    getClusterById: async () => cluster,
  } as unknown as IPredictionMarketRepository;

  const provider: IPredictionMarketProvider = {
    fetchFiltered: async () => [],
    fetchByIds: async () => {
      if (opts.warmTokensOnFetch) tokens = opts.warmTokensOnFetch;
      return [];
    },
    getOutcomeTokens: () => tokens,
  };

  const polymarket = {
    getOrderbookTopOfBook: async () => tob,
  } as unknown as IPolymarketAdapter;

  return { paperBetRepo, findingRepo, provider, polymarket, inserts };
}

function buildUseCase(m: Mocks, cfg: { paperStakeMinUsdcCents: number; paperStakeMaxUsdcCents: number } = { paperStakeMinUsdcCents: 100, paperStakeMaxUsdcCents: 100_000 }) {
  return new PredictionMarketPaperBetUseCase(m.paperBetRepo, m.findingRepo, m.provider, m.polymarket, cfg);
}

const placeArgs = {
  reqId: "r1",
  userId: "u1",
  findingId: "00000000-0000-0000-0000-000000000001",
  side: "A" as const,
  stakeUsdcCents: 1000,
};

// ── Tests ───────────────────────────────────────────────────────────────────

test("happy path: finding loaded, price snapshotted, row inserted with sharesE6", async () => {
  const m = buildMocks();
  const uc = buildUseCase(m);
  const out = await uc.place(placeArgs);

  assert.equal(out.userId, "u1");
  assert.equal(out.marketId, "m-A");
  assert.equal(out.side, "YES");
  assert.equal(out.entryPriceBps, 4500);
  // shares = stakeUsdc / priceFraction = ($10) / 0.45 = 22.222… → ×1e6 = 22_222_222 (truncated).
  // BigInt: (1000n * 100n * 1_000_000n) / 4500n = 22_222_222n.
  assert.equal(out.sharesE6, 22_222_222n);
  assert.equal(out.detectorSource, "deterministic");
  assert.equal(out.subject, "BTC_USD_SPOT");
  assert.equal(m.inserts.length, 1);
});

test("stake below min → ValidationError", async () => {
  const m = buildMocks();
  const uc = buildUseCase(m);
  await assert.rejects(
    () => uc.place({ ...placeArgs, stakeUsdcCents: 50 }),
    (err: unknown) =>
      err instanceof PaperBetValidationError && err.code === "stake-below-min",
  );
  assert.equal(m.inserts.length, 0);
});

test("stake above max → ValidationError", async () => {
  const m = buildMocks();
  const uc = buildUseCase(m);
  await assert.rejects(
    () => uc.place({ ...placeArgs, stakeUsdcCents: 200_000 }),
    (err: unknown) =>
      err instanceof PaperBetValidationError && err.code === "stake-above-max",
  );
});

test("non-positive integer stake → ValidationError", async () => {
  const m = buildMocks();
  const uc = buildUseCase(m);
  await assert.rejects(
    () => uc.place({ ...placeArgs, stakeUsdcCents: 0 }),
    (err: unknown) =>
      err instanceof PaperBetValidationError && err.code === "stake-not-positive-int",
  );
});

test("missing finding → NotFoundError", async () => {
  const m = buildMocks({ finding: null });
  const uc = buildUseCase(m);
  await assert.rejects(
    () => uc.place(placeArgs),
    (err: unknown) => err instanceof PaperBetNotFoundError && err.entity === "finding",
  );
});

test("missing cluster → NotFoundError", async () => {
  const m = buildMocks({ cluster: null });
  const uc = buildUseCase(m);
  await assert.rejects(
    () => uc.place(placeArgs),
    (err: unknown) => err instanceof PaperBetNotFoundError && err.entity === "cluster",
  );
});

test("degenerate priceBps=0 → PriceUnavailableError, no insert", async () => {
  const m = buildMocks({ tob: { bestBidPrice: 0, bestAskPrice: 0, midPrice: 0 } });
  const uc = buildUseCase(m);
  await assert.rejects(
    () => uc.place(placeArgs),
    (err: unknown) => err instanceof PaperBetPriceUnavailableError,
  );
  assert.equal(m.inserts.length, 0);
});

test("degenerate priceBps=10000 → PriceUnavailableError", async () => {
  const m = buildMocks({ tob: { bestBidPrice: 1, bestAskPrice: 1, midPrice: 1 } });
  const uc = buildUseCase(m);
  await assert.rejects(
    () => uc.place(placeArgs),
    (err: unknown) => err instanceof PaperBetPriceUnavailableError,
  );
});

test("token-cache cold: fetchByIds warms it, then succeeds", async () => {
  const m = buildMocks({
    tokens: null,
    warmTokensOnFetch: { yes: "tok-yes-warm", no: "tok-no-warm" },
  });
  const uc = buildUseCase(m);
  const out = await uc.place(placeArgs);
  assert.equal(out.entryPriceBps, 4500);
});

test("token-cache cold + fetchByIds doesn't populate → PriceUnavailableError", async () => {
  const m = buildMocks({ tokens: null });
  const uc = buildUseCase(m);
  await assert.rejects(
    () => uc.place(placeArgs),
    (err: unknown) => err instanceof PaperBetPriceUnavailableError,
  );
});

test("detectorSource = 'llm' when cluster.derivedSubject is null", async () => {
  const m = buildMocks({ cluster: llmCluster });
  const uc = buildUseCase(m);
  const out = await uc.place(placeArgs);
  assert.equal(out.detectorSource, "llm");
  assert.equal(out.subject, null);
});

test("side 'B' picks sideB.marketId and sideB.outcome", async () => {
  const finding = baseFinding({
    sideA: { label: "A", marketId: "m-A", outcome: "YES", rationale: "x" },
    sideB: { label: "B", marketId: "m-B", outcome: "NO", rationale: "y" },
  });
  const m = buildMocks({ finding });
  const uc = buildUseCase(m);
  const out = await uc.place({ ...placeArgs, side: "B" });
  assert.equal(out.marketId, "m-B");
  assert.equal(out.side, "NO");
});

test("pickSideThesis covers each pattern (positional)", () => {
  const fixtures: Array<{ patternType: StoredFinding["patternType"]; selector: "A" | "B"; expectedMarket: string }> = [
    { patternType: "logical_inconsistency", selector: "A", expectedMarket: "m-A" },
    { patternType: "logical_inconsistency", selector: "B", expectedMarket: "m-B" },
    { patternType: "term_structure_anomaly", selector: "A", expectedMarket: "m-A" },
    { patternType: "movement_divergence", selector: "B", expectedMarket: "m-B" },
    { patternType: "implied_contradiction", selector: "A", expectedMarket: "m-A" },
  ];
  for (const f of fixtures) {
    const finding = baseFinding({ patternType: f.patternType });
    const got = pickSideThesis(finding, f.selector);
    assert.equal(got?.marketId, f.expectedMarket, `pattern ${f.patternType} side ${f.selector}`);
  }
});

test("wireSideToSelector resolves YES/NO by SideThesis.outcome", () => {
  const finding = baseFinding({
    sideA: { label: "A", marketId: "m-A", outcome: "YES", rationale: "x" },
    sideB: { label: "B", marketId: "m-B", outcome: "NO", rationale: "y" },
  });
  assert.equal(wireSideToSelector(finding, "YES"), "A");
  assert.equal(wireSideToSelector(finding, "NO"), "B");
  assert.equal(wireSideToSelector(finding, "A"), "A");
  assert.equal(wireSideToSelector(finding, "B"), "B");
});

test("wireSideToSelector returns null when no side matches the requested outcome", () => {
  // Both sides bet YES → 'NO' has no matching side.
  const finding = baseFinding();
  assert.equal(wireSideToSelector(finding, "NO"), null);
});

// silence "unused" warnings for imported types used only in JSDoc-style annotations
const _typeAnchors: { _t?: SideThesis } = {};
void _typeAnchors;
