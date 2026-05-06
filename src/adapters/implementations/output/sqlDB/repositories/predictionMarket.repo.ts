import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { newUuid } from "../../../../../helpers/uuid";
import type {
  IPredictionMarketRepository,
  InsertRunInput,
} from "../../../../../use-cases/interface/predictionMarket/IPredictionMarketRepository";
import type {
  DraftCluster,
  ExpectedRelationship,
  RawMarket,
  RunRow,
  RunStatus,
  StoredCluster,
} from "../../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";
import {
  predictionMarketClusters,
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

  async insertClusters(runId: string, clusters: DraftCluster[]): Promise<void> {
    if (clusters.length === 0) return;
    const rows = clusters.map((c) => ({
      clusterId: newUuid(),
      runId,
      theme: c.theme,
      causalDriver: c.causalDriver,
      marketIds: c.marketIds,
      expectedRelationships: c.expectedRelationships,
      rationale: c.rationale,
      confidence: c.confidence,
    }));
    await this.db.insert(predictionMarketClusters).values(rows);
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
}

