import { desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { newUuid } from "../../../../../helpers/uuid";
import type {
  IPredictionMarketRepository,
  InsertRunInput,
} from "../../../../../use-cases/interface/predictionMarket/IPredictionMarketRepository";
import type {
  DraftCluster,
  ExpectedRelationship,
  FindingConfidence,
  FindingCurrentState,
  FindingPatternType,
  RawMarket,
  RunRow,
  RunStatus,
  SideThesis,
  StoredCluster,
  StoredFinding,
  VerifiedFinding,
} from "../../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";
import {
  predictionMarketClusters,
  predictionMarketFindings,
  predictionMarketRuns,
  predictionMarketSnapshots,
} from "../schema";

const USD_TO_CENTS = 100;
const PRICE_TO_BP = 10_000;

function toCents(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.round(usd * USD_TO_CENTS);
}

function fromCents(cents: number): number {
  return cents / USD_TO_CENTS;
}

function toBp(price: number): number {
  if (!Number.isFinite(price)) return 0;
  const bp = Math.round(price * PRICE_TO_BP);
  return Math.max(0, Math.min(PRICE_TO_BP, bp));
}

function fromBp(bp: number): number {
  return bp / PRICE_TO_BP;
}

export class DrizzlePredictionMarketRepo implements IPredictionMarketRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async insertRun(run: InsertRunInput): Promise<void> {
    await this.db.insert(predictionMarketRuns).values({
      runId: run.runId,
      createdAtEpoch: run.createdAtEpoch,
      universeHash: run.universeHash,
      clusterSetHash: run.clusterSetHash,
      status: run.status,
      isLatest: false,
    });
  }

  async setLatestRun(runId: string): Promise<void> {
    // Atomic flip — clear any prior winner then promote this run. Drizzle's
    // node-postgres adapter exposes `.transaction()` for this.
    await this.db.transaction(async (tx) => {
      await tx
        .update(predictionMarketRuns)
        .set({ isLatest: false })
        .where(eq(predictionMarketRuns.isLatest, true));
      await tx
        .update(predictionMarketRuns)
        .set({ isLatest: true })
        .where(eq(predictionMarketRuns.runId, runId));
    });
  }

  async getLatestRun(): Promise<RunRow | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketRuns)
      .where(eq(predictionMarketRuns.isLatest, true))
      .orderBy(desc(predictionMarketRuns.createdAtEpoch))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      runId: row.runId,
      createdAtEpoch: row.createdAtEpoch,
      universeHash: row.universeHash,
      clusterSetHash: row.clusterSetHash,
      status: row.status as RunStatus,
      isLatest: row.isLatest,
    };
  }

  async insertMarkets(runId: string, markets: RawMarket[]): Promise<void> {
    if (markets.length === 0) return;
    const rows = markets.map((m) => ({
      runId,
      marketId: m.marketId,
      slug: m.slug,
      question: m.question,
      resolutionCriteria: m.resolutionCriteria,
      category: m.category,
      resolutionEpochSec: m.resolutionEpochSec,
      yesPriceBp: toBp(m.yesPrice),
      noPriceBp: toBp(m.noPrice),
      openInterestUsdCents: toCents(m.openInterestUsd),
      volume7dUsdCents: toCents(m.volume7dUsd),
      liquidityUsdCents: toCents(m.liquidityUsd),
      url: m.url,
    }));
    await this.db.insert(predictionMarketSnapshots).values(rows);
  }

  async insertClusters(
    runId: string,
    clusters: Array<DraftCluster & { clusterId?: string }>,
  ): Promise<StoredCluster[]> {
    if (clusters.length === 0) return [];
    const rows = clusters.map((c) => ({
      clusterId: c.clusterId ?? newUuid(),
      runId,
      theme: c.theme,
      causalDriver: c.causalDriver,
      marketIds: c.marketIds,
      expectedRelationships: c.expectedRelationships,
      rationale: c.rationale,
      confidence: c.confidence,
    }));
    await this.db.insert(predictionMarketClusters).values(rows);
    return rows.map((r) => ({
      clusterId: r.clusterId,
      runId: r.runId,
      theme: r.theme,
      causalDriver: r.causalDriver,
      marketIds: r.marketIds,
      expectedRelationships: r.expectedRelationships,
      rationale: r.rationale,
      confidence: r.confidence,
    }));
  }

  async updateRunStatus(
    runId: string,
    status: RunStatus,
    clusterSetHash?: string,
  ): Promise<void> {
    const set: { status: RunStatus; clusterSetHash?: string } = { status };
    if (clusterSetHash !== undefined) set.clusterSetHash = clusterSetHash;
    await this.db
      .update(predictionMarketRuns)
      .set(set)
      .where(eq(predictionMarketRuns.runId, runId));
  }

  async getMarketsByRun(runId: string): Promise<RawMarket[]> {
    const rows = await this.db
      .select()
      .from(predictionMarketSnapshots)
      .where(eq(predictionMarketSnapshots.runId, runId));
    return rows.map((r) => ({
      marketId: r.marketId,
      slug: r.slug,
      question: r.question,
      resolutionCriteria: r.resolutionCriteria,
      category: r.category,
      resolutionEpochSec: r.resolutionEpochSec,
      yesPrice: fromBp(r.yesPriceBp),
      noPrice: fromBp(r.noPriceBp),
      openInterestUsd: fromCents(r.openInterestUsdCents),
      volume7dUsd: fromCents(r.volume7dUsdCents),
      liquidityUsd: fromCents(r.liquidityUsdCents),
      isActive: true,
      isDisputed: false,
      outcomesCount: 2,
      url: r.url,
    }));
  }

  async getClustersByRun(runId: string): Promise<StoredCluster[]> {
    const rows = await this.db
      .select()
      .from(predictionMarketClusters)
      .where(eq(predictionMarketClusters.runId, runId));
    return rows.map((r) => ({
      clusterId: r.clusterId,
      runId: r.runId,
      theme: r.theme,
      causalDriver: r.causalDriver,
      marketIds: r.marketIds as string[],
      expectedRelationships: r.expectedRelationships as ExpectedRelationship[],
      rationale: r.rationale,
      confidence: r.confidence as StoredCluster["confidence"],
    }));
  }

  async insertFindings(findings: VerifiedFinding[]): Promise<void> {
    if (findings.length === 0) return;
    const rows = findings.map((f) => ({
      findingId: f.findingId,
      runId: f.runId,
      clusterId: f.clusterId,
      patternType: f.patternType,
      marketsInvolved: f.marketsInvolved,
      currentState: f.currentState,
      liveOdds: f.liveOdds,
      whyAnomalous: f.whyAnomalous,
      sideA: f.sideA,
      sideB: f.sideB,
      confidence: f.confidence,
      magnitudeBps: f.magnitudeBps,
      rankScore: f.rankScore,
      rationale: f.rationale,
      createdAtEpoch: f.verifiedAtEpoch,
      broadcastedAtEpoch: null as number | null,
    }));
    await this.db.insert(predictionMarketFindings).values(rows);
  }

  async markFindingsBroadcasted(findingIds: string[], epoch: number): Promise<void> {
    if (findingIds.length === 0) return;
    await this.db
      .update(predictionMarketFindings)
      .set({ broadcastedAtEpoch: epoch })
      .where(inArray(predictionMarketFindings.findingId, findingIds));
  }

  async getFindingsByRun(runId: string): Promise<StoredFinding[]> {
    const rows = await this.db
      .select()
      .from(predictionMarketFindings)
      .where(eq(predictionMarketFindings.runId, runId))
      .orderBy(desc(predictionMarketFindings.rankScore));
    return rows.map((r) => mapFindingRow(r));
  }

  async getFinding(findingId: string): Promise<StoredFinding | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketFindings)
      .where(eq(predictionMarketFindings.findingId, findingId))
      .limit(1);
    const r = rows[0];
    return r ? mapFindingRow(r) : null;
  }
}

type FindingRow = {
  findingId: string;
  runId: string;
  clusterId: string;
  patternType: string;
  marketsInvolved: unknown;
  currentState: unknown;
  liveOdds: unknown;
  whyAnomalous: string;
  sideA: unknown;
  sideB: unknown;
  confidence: string;
  magnitudeBps: number;
  rankScore: number;
  rationale: string;
  createdAtEpoch: number;
  broadcastedAtEpoch: number | null;
};

function mapFindingRow(r: FindingRow): StoredFinding {
  return {
    findingId: r.findingId,
    runId: r.runId,
    clusterId: r.clusterId,
    patternType: r.patternType as FindingPatternType,
    marketsInvolved: r.marketsInvolved as string[],
    currentState: r.currentState as FindingCurrentState,
    liveOdds: r.liveOdds as Record<string, number>,
    whyAnomalous: r.whyAnomalous,
    sideA: r.sideA as SideThesis,
    sideB: r.sideB as SideThesis,
    confidence: r.confidence as FindingConfidence,
    magnitudeBps: r.magnitudeBps,
    rankScore: r.rankScore,
    rationale: r.rationale,
    verifiedAtEpoch: r.createdAtEpoch,
    createdAtEpoch: r.createdAtEpoch,
    broadcastedAtEpoch: r.broadcastedAtEpoch,
  };
}

