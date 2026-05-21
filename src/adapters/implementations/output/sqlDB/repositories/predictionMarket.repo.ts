import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { newUuid } from "../../../../../helpers/uuid";
import type {
  InsertRunInput,
  InsertShadowFindingInput,
  IPredictionMarketRepository,
  ShadowAgreementReport,
  ShadowAgreementSubjectRow,
} from "../../../../../use-cases/interface/predictionMarket/IPredictionMarketRepository";
import { inferSubject } from "../../../../../use-cases/interface/predictionMarket/marketFactFormat";
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
  predictionMarketClustersShadow,
  predictionMarketFacts,
  predictionMarketFindings,
  predictionMarketFindingsShadow,
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

type SnapshotRow = typeof predictionMarketSnapshots.$inferSelect;

function toRawMarket(r: SnapshotRow): RawMarket {
  return {
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
    polymarketEventId: r.polymarketEventId,
  };
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
      polymarketEventId: m.polymarketEventId ?? null,
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
      derivedSubject: c.derivedSubject ?? null,
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
      derivedSubject: r.derivedSubject,
    }));
  }

  async insertShadowClusters(
    runId: string,
    clusters: DraftCluster[],
    createdAtEpoch: number,
  ): Promise<void> {
    if (clusters.length === 0) return;
    const rows = clusters.map((c) => ({
      shadowClusterId: newUuid(),
      runId,
      pipeline: "deterministic" as const,
      derivedSubject: c.derivedSubject ?? null,
      theme: c.theme,
      causalDriver: c.causalDriver,
      marketIds: c.marketIds,
      expectedRelationships: c.expectedRelationships,
      rationale: c.rationale,
      confidence: c.confidence,
      createdAtEpoch,
    }));
    await this.db.insert(predictionMarketClustersShadow).values(rows);
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
    return rows.map((r) => toRawMarket(r));
  }

  async getMarketsByIds(ids: string[]): Promise<RawMarket[]> {
    if (ids.length === 0) return [];
    const unique = Array.from(new Set(ids));
    // Correlated subquery: for each requested marketId pick the row whose run
    // has the highest created_at_epoch. Positions on markets dropped from the
    // latest run still resolve to their last-seen question text.
    const rows = await this.db
      .select()
      .from(predictionMarketSnapshots)
      .where(
        and(
          inArray(predictionMarketSnapshots.marketId, unique),
          eq(
            predictionMarketSnapshots.runId,
            sql`(
              SELECT s2.run_id
              FROM ${predictionMarketSnapshots} s2
              JOIN ${predictionMarketRuns} r2 ON r2.run_id = s2.run_id
              WHERE s2.market_id = ${predictionMarketSnapshots.marketId}
              ORDER BY r2.created_at_epoch DESC
              LIMIT 1
            )`,
          ),
        ),
      );
    return rows.map((r) => toRawMarket(r));
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
      derivedSubject: r.derivedSubject,
    }));
  }

  async getClusterById(clusterId: string): Promise<StoredCluster | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketClusters)
      .where(eq(predictionMarketClusters.clusterId, clusterId))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      clusterId: r.clusterId,
      runId: r.runId,
      theme: r.theme,
      causalDriver: r.causalDriver,
      marketIds: r.marketIds as string[],
      expectedRelationships: r.expectedRelationships as ExpectedRelationship[],
      rationale: r.rationale,
      confidence: r.confidence as StoredCluster["confidence"],
      derivedSubject: r.derivedSubject,
    };
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
      sizedTrades: f.sizedTrades ?? null,
      expectedProfitUsdcCents: f.expectedProfitUsdc !== undefined ? Math.round(f.expectedProfitUsdc * 100) : null,
      minPayoffUsdcCents: f.minPayoffUsdc !== undefined ? Math.round(f.minPayoffUsdc * 100) : null,
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

  async insertShadowFindings(input: InsertShadowFindingInput[]): Promise<void> {
    if (input.length === 0) return;
    const rows = input.map((f) => ({
      shadowFindingId: newUuid(),
      runId: f.runId,
      shadowClusterId: f.source.kind === "shadow" ? f.source.shadowClusterId : null,
      realClusterId: f.source.kind === "real" ? f.source.realClusterId : null,
      pipeline: "deterministic" as const,
      patternType: f.patternType,
      marketsInvolved: f.marketsInvolved,
      liveOdds: f.liveOdds,
      magnitudeBps: f.magnitudeBps,
      widerMarketId: f.widerMarketId,
      narrowerMarketId: f.narrowerMarketId,
      earlierMarketId: f.earlierMarketId,
      laterMarketId: f.laterMarketId,
      rationale: f.rationale,
      confidence: f.confidence,
      createdAtEpoch: f.createdAtEpoch,
    }));
    await this.db.insert(predictionMarketFindingsShadow).values(rows);
  }

  /**
   * Per-subject agreement = match on (sorted marketsInvolved + patternType)
   * between LLM rows in `prediction_market_findings` and deterministic rows
   * in `prediction_market_findings_shadow` for the trailing `windowSec`.
   * Subject is read from `prediction_market_facts` using the first market in
   * each finding's `marketsInvolved`.
   */
  async getShadowAgreement(windowSec: number): Promise<ShadowAgreementReport> {
    const cutoff = Math.floor(Date.now() / 1000) - windowSec;
    const [llm, shadow] = await Promise.all([
      this.db
        .select({
          patternType: predictionMarketFindings.patternType,
          marketsInvolved: predictionMarketFindings.marketsInvolved,
        })
        .from(predictionMarketFindings)
        .where(gte(predictionMarketFindings.createdAtEpoch, cutoff)),
      this.db
        .select({
          patternType: predictionMarketFindingsShadow.patternType,
          marketsInvolved: predictionMarketFindingsShadow.marketsInvolved,
        })
        .from(predictionMarketFindingsShadow)
        .where(gte(predictionMarketFindingsShadow.createdAtEpoch, cutoff)),
    ]);
    const allIds = Array.from(
      new Set(
        [...llm, ...shadow].flatMap((r) => (r.marketsInvolved as string[]) ?? []),
      ),
    );
    const subjectByMarket = new Map<string, string>();
    if (allIds.length > 0) {
      const factRows = await this.db
        .select({
          marketId: predictionMarketFacts.marketId,
          subject: predictionMarketFacts.subject,
        })
        .from(predictionMarketFacts)
        .where(inArray(predictionMarketFacts.marketId, allIds));
      for (const r of factRows) subjectByMarket.set(r.marketId, r.subject);
    }

    const key = (markets: string[], pattern: string): string =>
      `${pattern}::${[...markets].sort().join("|")}`;
    const llmKeys = new Map<string, string>();
    for (const r of llm) {
      const ids = r.marketsInvolved as string[];
      llmKeys.set(key(ids, r.patternType), inferSubject(ids, subjectByMarket));
    }
    const shadowKeys = new Map<string, string>();
    for (const r of shadow) {
      const ids = r.marketsInvolved as string[];
      shadowKeys.set(key(ids, r.patternType), inferSubject(ids, subjectByMarket));
    }

    const bySubject = new Map<string, ShadowAgreementSubjectRow>();
    const get = (s: string): ShadowAgreementSubjectRow => {
      let row = bySubject.get(s);
      if (!row) {
        row = { subject: s, llmOnly: 0, shadowOnly: 0, agreed: 0, agreementPct: 0 };
        bySubject.set(s, row);
      }
      return row;
    };
    for (const [k, subj] of llmKeys) {
      const row = get(subj);
      if (shadowKeys.has(k)) row.agreed += 1;
      else row.llmOnly += 1;
    }
    for (const [k, subj] of shadowKeys) {
      if (llmKeys.has(k)) continue;
      get(subj).shadowOnly += 1;
    }
    let overallAgreed = 0;
    let overallLlmOnly = 0;
    let overallShadowOnly = 0;
    for (const row of bySubject.values()) {
      const total = row.agreed + row.llmOnly;
      row.agreementPct = total === 0 ? 0 : Math.round((row.agreed / total) * 1000) / 10;
      overallAgreed += row.agreed;
      overallLlmOnly += row.llmOnly;
      overallShadowOnly += row.shadowOnly;
    }
    const overallTotal = overallAgreed + overallLlmOnly;
    return {
      perSubject: Array.from(bySubject.values()).sort((a, b) => a.subject.localeCompare(b.subject)),
      overall: {
        agreed: overallAgreed,
        llmOnly: overallLlmOnly,
        shadowOnly: overallShadowOnly,
        agreementPct: overallTotal === 0 ? 0 : Math.round((overallAgreed / overallTotal) * 1000) / 10,
      },
      windowDays: Math.round(windowSec / 86400),
    };
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
  sizedTrades: unknown;
  expectedProfitUsdcCents: number | null;
  minPayoffUsdcCents: number | null;
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
    sizedTrades: (r.sizedTrades as VerifiedFinding["sizedTrades"]) ?? undefined,
    expectedProfitUsdc: r.expectedProfitUsdcCents !== null ? r.expectedProfitUsdcCents / 100 : undefined,
    minPayoffUsdc: r.minPayoffUsdcCents !== null ? r.minPayoffUsdcCents / 100 : undefined,
  };
}

