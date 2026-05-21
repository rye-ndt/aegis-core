/**
 * Replay regression test (Part 7 ongoing hygiene). Each fixture in
 * `fixtures/prediction-markets-replay/` is run through the deterministic
 * pipeline (detector + verifier; provider mocked to echo the snapshot).
 * Findings are matched by `(patternType, sorted marketsInvolved,
 * magnitudeBps ± 10bps)` plus role tags — UUIDs are ignored.
 *
 * Any drift fails CI; new primitives ship with a new fixture in the same PR.
 *
 * Run:
 *   npx tsx --test src/__tests__/predictionMarketsReplay.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DeterministicPredictionMarketDetector } from "../adapters/implementations/output/predictionMarket/deterministicPredictionMarketDetector";
import { PredictionMarketVerifier } from "../adapters/implementations/output/predictionMarket/predictionMarketVerifier";
import type { IPredictionMarketFactRepository } from "../use-cases/interface/predictionMarket/IPredictionMarketFactRepository";
import type { IPredictionMarketProvider } from "../use-cases/interface/predictionMarket/IPredictionMarketProvider";
import type { MarketFact } from "../use-cases/interface/predictionMarket/MarketFactTypes";
import type { RawMarket, VerifiedFinding } from "../use-cases/interface/predictionMarket/PredictionMarketTypes";

import { fixture as btcSubset } from "./fixtures/prediction-markets-replay/btc_subset";
import { fixture as electionPartition } from "./fixtures/prediction-markets-replay/election_partition";
import { fixture as btcTermStructure } from "./fixtures/prediction-markets-replay/btc_term_structure";

const MAG_TOLERANCE_BPS = 10;

interface ExpectedFinding {
  patternType: string;
  marketsInvolved: string[];
  magnitudeBps: number;
  widerMarketId?: string;
  narrowerMarketId?: string;
  earlierMarketId?: string;
  laterMarketId?: string;
}

interface Fixture {
  name: string;
  runId: string;
  cluster: import("../use-cases/interface/predictionMarket/PredictionMarketTypes").StoredCluster;
  members: RawMarket[];
  facts: Map<string, MarketFact>;
  expected: ExpectedFinding[];
}

function mockFactRepo(facts: Map<string, MarketFact>): IPredictionMarketFactRepository {
  return {
    getByMarketId: async (id) => facts.get(id) ?? null,
    getByMarketIds: async (ids) => {
      const out = new Map<string, MarketFact>();
      for (const id of ids) {
        const f = facts.get(id);
        if (f) out.set(id, f);
      }
      return out;
    },
    upsertFact: async () => undefined,
    insertReview: async () => undefined,
    getReview: async () => null,
    resolveReview: async () => undefined,
    listPendingReviews: async () => [],
  };
}

function mockProvider(members: RawMarket[]): IPredictionMarketProvider {
  const byId = new Map(members.map((m) => [m.marketId, m]));
  return {
    fetchFiltered: async () => members,
    fetchByIds: async (ids) => ids.map((id) => byId.get(id)).filter((m): m is RawMarket => !!m),
  };
}

async function runFixture(f: Fixture): Promise<VerifiedFinding[]> {
  const detector = new DeterministicPredictionMarketDetector(mockFactRepo(f.facts), {
    tolBps: 0,
    highConfidenceLiquidityUsd: 100_000,
    highConfidenceMagnitudeBps: 500,
  });
  const verifier = new PredictionMarketVerifier({
    provider: mockProvider(f.members),
    verifyFreshnessMs: 60_000,
    oddsDriftToleranceBps: 50,
    minGapBps: 0,
    minSumDeviationBps: 0,
    findingMinLiquidityUsd: 0,
  });

  const { drafts } = await detector.detect({ cluster: f.cluster, members: f.members, reqId: "replay" });
  const verified = await verifier.verify({
    reqId: "replay",
    runId: f.runId,
    cluster: f.cluster,
    snapshotMembers: f.members,
    drafts,
  });
  return verified;
}

function matchKey(f: { patternType: string; marketsInvolved: string[] }): string {
  return `${f.patternType}::${[...f.marketsInvolved].sort().join("|")}`;
}

for (const fixture of [btcSubset, electionPartition, btcTermStructure] satisfies Fixture[]) {
  test(`replay: ${fixture.name} — same findings, same role tags`, async () => {
    const actual = await runFixture(fixture);
    const actualByKey = new Map(actual.map((f) => [matchKey(f), f]));
    assert.equal(
      actual.length,
      fixture.expected.length,
      `expected ${fixture.expected.length} findings, got ${actual.length}`,
    );
    for (const exp of fixture.expected) {
      const key = matchKey(exp);
      const got = actualByKey.get(key);
      assert.ok(got, `missing finding ${key}`);
      assert.ok(
        Math.abs(got.magnitudeBps - exp.magnitudeBps) <= MAG_TOLERANCE_BPS,
        `magnitude drift for ${key}: expected ${exp.magnitudeBps} ± ${MAG_TOLERANCE_BPS}, got ${got.magnitudeBps}`,
      );
      if (exp.widerMarketId) assert.equal(got.widerMarketId, exp.widerMarketId, `wider role drift on ${key}`);
      if (exp.narrowerMarketId) assert.equal(got.narrowerMarketId, exp.narrowerMarketId, `narrower role drift on ${key}`);
      if (exp.earlierMarketId) assert.equal(got.earlierMarketId, exp.earlierMarketId, `earlier role drift on ${key}`);
      if (exp.laterMarketId) assert.equal(got.laterMarketId, exp.laterMarketId, `later role drift on ${key}`);
    }
  });
}
