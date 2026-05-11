import { createHash } from "crypto";
import pLimit from "p-limit";
import { PREDICTION_MARKETS_ENV } from "../../helpers/env/predictionMarketEnv";
import { createLogger } from "../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import { toClassifierRecord } from "../interface/predictionMarket/IPredictionMarketClassifier";
import type { IPredictionMarketBroadcaster } from "../interface/predictionMarket/IPredictionMarketBroadcaster";
import type { IPredictionMarketClassifier } from "../interface/predictionMarket/IPredictionMarketClassifier";
import type { IPredictionMarketDetector } from "../interface/predictionMarket/IPredictionMarketDetector";
import type { IPredictionMarketFindingBroadcaster } from "../interface/predictionMarket/IPredictionMarketFindingBroadcaster";
import type { IPredictionMarketProvider } from "../interface/predictionMarket/IPredictionMarketProvider";
import type { IPredictionMarketRepository } from "../interface/predictionMarket/IPredictionMarketRepository";
import type { IPredictionMarketVerifier } from "../interface/predictionMarket/IPredictionMarketVerifier";
import type { IPredictionMarketFactRepository } from "../interface/predictionMarket/IPredictionMarketFactRepository";
import { parseCutOverSubjects } from "../interface/predictionMarket/marketFactVocabularies";
import type {
  DraftCluster,
  RawMarket,
  RunOutcome,
  StoredCluster,
  VerifiedFinding,
} from "../interface/predictionMarket/PredictionMarketTypes";
import type { PredictionMarketDeterministicClusterUseCase } from "./predictionMarketDeterministicCluster.usecase";

const log = createLogger("predictionMarketScan");

function hashUniverse(markets: RawMarket[]): string {
  const parts = markets
    .map((m) => `${m.marketId}@${m.resolutionEpochSec}`)
    .sort()
    .join("|");
  return createHash("sha256").update(parts).digest("hex");
}

function hashClusterSet(clusters: DraftCluster[]): string {
  const parts = clusters
    .map((c) => `${c.theme}::${[...c.marketIds].sort().join(",")}`)
    .sort()
    .join("|");
  return createHash("sha256").update(parts).digest("hex");
}

function diffCount(prevIds: Set<string>, current: RawMarket[]): number {
  let added = 0;
  let removed = 0;
  const currentIds = new Set(current.map((m) => m.marketId));
  for (const id of currentIds) if (!prevIds.has(id)) added += 1;
  for (const id of prevIds) if (!currentIds.has(id)) removed += 1;
  return added + removed;
}

/**
 * Routing rule for stage-3. Exported pure function so the deterministic-only
 * invariant (Part 7) can be enforced by a unit test:
 * `pickDetector` must never return the LLM detector for a cut-over subject.
 */
export function pickDetector(
  cluster: Pick<StoredCluster, "derivedSubject">,
  cutOverSubjects: Set<string>,
  llmDetector: IPredictionMarketDetector | null,
  deterministicDetector: IPredictionMarketDetector | null,
): IPredictionMarketDetector | null {
  const subject = cluster.derivedSubject ?? null;
  if (subject && cutOverSubjects.has(subject) && deterministicDetector) {
    return deterministicDetector;
  }
  return llmDetector;
}

function carryForward(stored: StoredCluster[]): DraftCluster[] {
  return stored.map((s) => ({
    theme: s.theme,
    causalDriver: s.causalDriver,
    marketIds: s.marketIds,
    expectedRelationships: s.expectedRelationships,
    rationale: s.rationale,
    confidence: s.confidence,
    derivedSubject: s.derivedSubject ?? null,
  }));
}

function clusterContentKey(c: { theme: string; marketIds: string[] }): string {
  return `${c.theme}::${[...c.marketIds].sort().join(",")}`;
}

export class PredictionMarketScanUseCase {
  constructor(
    private readonly provider: IPredictionMarketProvider,
    private readonly classifier: IPredictionMarketClassifier,
    private readonly repo: IPredictionMarketRepository,
    private readonly broadcaster: IPredictionMarketBroadcaster | null,
    private readonly detector: IPredictionMarketDetector | null = null,
    private readonly verifier: IPredictionMarketVerifier | null = null,
    private readonly findingBroadcaster: IPredictionMarketFindingBroadcaster | null = null,
    private readonly deterministicCluster: PredictionMarketDeterministicClusterUseCase | null = null,
    private readonly deterministicDetector: IPredictionMarketDetector | null = null,
    private readonly factRepo: IPredictionMarketFactRepository | null = null,
  ) {}

  async runOnce(reqId: string): Promise<RunOutcome> {
    const tickStart = Date.now();
    const env = PREDICTION_MARKETS_ENV;

    log.info({ step: "tick-start", reqId }, "scan");

    // 1. fetch universe
    log.info({ step: "fetch-start", reqId }, "scan");
    const markets = await this.provider.fetchFiltered(
      {
        minOpenInterestUsd: env.minOpenInterestUsd,
        minVolume7dUsd: env.minVolume7dUsd,
        minDaysToResolution: env.minDaysToResolution,
        maxDaysToResolution: env.maxDaysToResolution,
        topN: env.topN,
      },
      reqId,
    );
    log.info({ step: "fetch-end", reqId, marketCount: markets.length }, "scan");

    if (markets.length === 0) {
      log.warn({ reqId }, "scan no-markets");
      return {
        runId: "",
        fetched: 0,
        clusters: 0,
        published: 0,
        broadcast: false,
        findingsDetected: 0,
        findingsVerified: 0,
        findingsBroadcast: 0,
      };
    }

    const universeHash = hashUniverse(markets);
    const lastRun = await this.repo.getLatestRun();

    const prevMarketIds = lastRun
      ? new Set((await this.repo.getMarketsByRun(lastRun.runId)).map((m) => m.marketId))
      : new Set<string>();

    const ageMs = lastRun ? Date.now() - lastRun.createdAtEpoch * 1000 : Number.POSITIVE_INFINITY;
    const shouldRecluster =
      !lastRun ||
      lastRun.universeHash !== universeHash ||
      diffCount(prevMarketIds, markets) > env.reclusterDelta ||
      ageMs > env.maxReclusterAgeMs;

    log.info(
      {
        step: "recluster-decision",
        reqId,
        shouldRecluster,
        hadLastRun: !!lastRun,
        universeHashChanged: lastRun ? lastRun.universeHash !== universeHash : true,
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
      },
      "scan",
    );

    const runId = newUuid();
    const nowSec = newCurrentUTCEpoch();
    await this.repo.insertRun({
      runId,
      createdAtEpoch: nowSec,
      universeHash,
      clusterSetHash: null,
      status: "fetched",
    });
    await this.repo.insertMarkets(runId, markets);

    const cutOverSubjects = parseCutOverSubjects(env.deterministicSubjects);
    const needFacts =
      !!this.deterministicCluster && (cutOverSubjects.size > 0 || env.shadowMode);
    const factsByMarketId = needFacts && this.factRepo
      ? await this.factRepo.getByMarketIds(markets.map((m) => m.marketId))
      : null;

    let clusters: DraftCluster[];
    // Carry-forward keeps the prior run's clusterId so the stage-3 detector
    // cache and `prediction_market_findings.cluster_id` remain stable.
    let priorClusterIdByContent: Map<string, string> | null = null;
    if (shouldRecluster) {
      let deterministic: DraftCluster[] = [];
      let llmEligible = markets;
      if (this.deterministicCluster && cutOverSubjects.size > 0) {
        const detResult = await this.deterministicCluster.cluster({
          runId, universe: markets, cutOverSubjects, reqId,
          factsByMarketId: factsByMarketId ?? undefined,
        });
        deterministic = detResult.deterministic;
        llmEligible = detResult.llmEligible;
      }

      log.info(
        { step: "classify-start", reqId, marketCount: llmEligible.length, deterministicCount: deterministic.length },
        "scan",
      );
      const llmClusters = llmEligible.length >= 3
        ? await this.classifier.classify({
            markets: llmEligible.map(toClassifierRecord),
            reqId,
          })
        : [];
      clusters = [...deterministic, ...llmClusters];
      log.info(
        { step: "classify-end", reqId, clusters: clusters.length, deterministic: deterministic.length, llm: llmClusters.length },
        "scan",
      );

      if (this.deterministicCluster && env.shadowMode) {
        try {
          const shadow = await this.deterministicCluster.cluster({
            runId, universe: markets, cutOverSubjects, reqId, shadowMode: true,
            factsByMarketId: factsByMarketId ?? undefined,
          });
          await this.repo.insertShadowClusters(runId, shadow.deterministic, nowSec);
          log.info(
            { step: "shadow-write", reqId, runId, shadowClusters: shadow.deterministic.length },
            "scan",
          );
        } catch (err) {
          log.error({ err, reqId, runId }, "shadow-write failed");
        }
      }
    } else {
      const prior = await this.repo.getClustersByRun(lastRun!.runId);
      clusters = carryForward(prior);
      priorClusterIdByContent = new Map(prior.map((p) => [clusterContentKey(p), p.clusterId]));
      log.info({ step: "classify-skipped", reqId, clusters: clusters.length }, "scan");
    }

    const storedClusters = await this.repo.insertClusters(
      runId,
      clusters.map((c) => ({
        ...c,
        clusterId: priorClusterIdByContent?.get(clusterContentKey(c)),
      })),
    );

    for (const c of clusters) {
      if (c.confidence === "medium") {
        log.warn({ reqId, theme: c.theme, marketCount: c.marketIds.length }, "cluster medium-confidence pending review");
      }
    }
    const published = clusters.filter((c) => c.confidence === "high");
    const publishedStored = storedClusters.filter((c) => c.confidence === "high");

    const clusterSetHash = hashClusterSet(published);
    await this.repo.updateRunStatus(runId, "clustered", clusterSetHash);
    await this.repo.setLatestRun(runId);

    const lastPublishedHash = lastRun?.clusterSetHash ?? null;
    let broadcast = false;
    if (
      this.broadcaster &&
      published.length > 0 &&
      clusterSetHash !== lastPublishedHash
    ) {
      log.info({ step: "broadcast-start", reqId, clusters: published.length }, "scan");
      const result = await this.broadcaster.broadcast({
        runId,
        clusterSetHash,
        clusters: published,
        reqId,
      });
      log.info({ step: "broadcast-end", reqId, sent: result.sent, skipped: result.skipped }, "scan");
      await this.repo.updateRunStatus(runId, "published", clusterSetHash);
      broadcast = true;
    }

    let findingsDetected = 0;
    let findingsVerified = 0;
    let findingsBroadcast = 0;
    if (env.findingsEnabled && this.detector && this.verifier && publishedStored.length > 0) {
      log.info(
        {
          step: "stage3-start",
          reqId,
          runId,
          eligibleClusters: publishedStored.length,
          filteredOutClusters: clusters.length - publishedStored.length,
        },
        "scan",
      );

      const marketById = new Map<string, RawMarket>();
      for (const m of markets) marketById.set(m.marketId, m);

      const stage3Limit = pLimit(env.detectorConcurrency);
      // Per-tick routing visibility — counts which detector served each
      // cluster. Lets operators verify cut-over routing without grepping
      // per-cluster logs.
      let deterministicClustersServed = 0;
      let llmClustersServed = 0;
      let detectorlessClusters = 0;
      for (const c of publishedStored) {
        const d = this.detectorFor(c, cutOverSubjects);
        if (!d) detectorlessClusters += 1;
        else if (d === this.deterministicDetector) deterministicClustersServed += 1;
        else llmClustersServed += 1;
      }
      log.info(
        {
          step: "stage3-routing",
          reqId,
          runId,
          deterministicClustersServed,
          llmClustersServed,
          detectorlessClusters,
          cutOverSubjects: Array.from(cutOverSubjects),
        },
        "scan",
      );
      const perCluster = await Promise.all(
        publishedStored.map((cluster) =>
          stage3Limit(() => this.runStage3ForCluster(cluster, marketById, runId, reqId, cutOverSubjects)),
        ),
      );

      if (env.shadowMode && this.deterministicDetector && this.verifier) {
        await this.runShadowDetector(publishedStored, marketById, runId, reqId, stage3Limit);
      }

      findingsDetected = perCluster.reduce((acc, p) => acc + p.drafts, 0);
      const allVerified = perCluster
        .flatMap((p) => p.verified)
        .sort((a, b) => b.rankScore - a.rankScore);
      findingsVerified = allVerified.length;

      if (allVerified.length > 0) {
        await this.repo.insertFindings(allVerified);

        if (this.findingBroadcaster) {
          const clusterById = new Map<string, StoredCluster>();
          for (const c of publishedStored) clusterById.set(c.clusterId, c);
          const result = await this.findingBroadcaster.broadcast({
            runId,
            reqId,
            findings: allVerified,
            clusterById,
            marketById,
          });
          findingsBroadcast = result.sent;
          await this.repo.markFindingsBroadcasted(
            allVerified.map((f) => f.findingId),
            newCurrentUTCEpoch(),
          );
        }
      }

      log.info(
        {
          step: "stage3-end",
          reqId,
          runId,
          findingsDetected,
          findingsVerified,
          findingsBroadcast,
          durationMs: Date.now() - tickStart,
        },
        "scan",
      );
    }

    log.info(
      {
        step: "tick-end",
        reqId,
        runId,
        fetched: markets.length,
        clusters: clusters.length,
        published: published.length,
        broadcast,
        findingsDetected,
        findingsVerified,
        findingsBroadcast,
        durationMs: Date.now() - tickStart,
      },
      "scan",
    );

    return {
      runId,
      fetched: markets.length,
      clusters: clusters.length,
      published: published.length,
      broadcast,
      findingsDetected,
      findingsVerified,
      findingsBroadcast,
    };
  }

  private async runStage3ForCluster(
    cluster: StoredCluster,
    marketById: Map<string, RawMarket>,
    runId: string,
    reqId: string,
    cutOverSubjects: Set<string>,
  ): Promise<{ drafts: number; verified: VerifiedFinding[] }> {
    if (!this.verifier) return { drafts: 0, verified: [] };
    const detector = this.detectorFor(cluster, cutOverSubjects);
    if (!detector) return { drafts: 0, verified: [] };
    const members: RawMarket[] = [];
    for (const id of cluster.marketIds) {
      const m = marketById.get(id);
      if (m) members.push(m);
    }
    if (members.length < 2) return { drafts: 0, verified: [] };
    try {
      const drafts = await detector.detect({ cluster, members, reqId });
      if (drafts.length === 0) return { drafts: 0, verified: [] };
      const verified = await this.verifier.verify({
        reqId,
        runId,
        cluster,
        snapshotMembers: members,
        drafts,
      });
      return { drafts: drafts.length, verified };
    } catch (err) {
      log.error({ err, reqId, runId, clusterId: cluster.clusterId }, "stage3 cluster failed");
      return { drafts: 0, verified: [] };
    }
  }

  private detectorFor(
    cluster: StoredCluster,
    cutOverSubjects: Set<string>,
  ): IPredictionMarketDetector | null {
    return pickDetector(cluster, cutOverSubjects, this.detector, this.deterministicDetector);
  }

  private async runShadowDetector(
    publishedStored: StoredCluster[],
    marketById: Map<string, RawMarket>,
    runId: string,
    reqId: string,
    limit: ReturnType<typeof pLimit>,
  ): Promise<void> {
    if (!this.deterministicDetector || !this.verifier) return;
    const start = Date.now();
    try {
      const per = await Promise.all(
        publishedStored.map((cluster) =>
          limit(() => this.runShadowDetectForCluster(cluster, marketById, runId, reqId)),
        ),
      );
      const shadowInputs = per.flat();
      if (shadowInputs.length > 0) {
        await this.repo.insertShadowFindings(shadowInputs);
      }
      log.info(
        { step: "shadow-detect-end", reqId, runId, shadowFindings: shadowInputs.length, durationMs: Date.now() - start },
        "scan",
      );
    } catch (err) {
      log.error({ err, reqId, runId }, "shadow-detect failed");
    }
  }

  private async runShadowDetectForCluster(
    cluster: StoredCluster,
    marketById: Map<string, RawMarket>,
    runId: string,
    reqId: string,
  ): Promise<import("../interface/predictionMarket/IPredictionMarketRepository").InsertShadowFindingInput[]> {
    if (!this.deterministicDetector || !this.verifier) return [];
    const members: RawMarket[] = [];
    for (const id of cluster.marketIds) {
      const m = marketById.get(id);
      if (m) members.push(m);
    }
    if (members.length < 2) return [];
    const drafts = await this.deterministicDetector.detect({ cluster, members, reqId });
    if (drafts.length === 0) return [];
    const verified = await this.verifier.verify({
      reqId,
      runId,
      cluster,
      snapshotMembers: members,
      drafts,
    });
    return verified.map((v) => ({
      runId,
      source: { kind: "real" as const, realClusterId: cluster.clusterId },
      patternType: v.patternType,
      marketsInvolved: v.marketsInvolved,
      liveOdds: v.liveOdds,
      magnitudeBps: v.magnitudeBps,
      widerMarketId: v.widerMarketId ?? null,
      narrowerMarketId: v.narrowerMarketId ?? null,
      earlierMarketId: v.earlierMarketId ?? null,
      laterMarketId: v.laterMarketId ?? null,
      rationale: v.rationale,
      confidence: v.confidence,
      createdAtEpoch: v.verifiedAtEpoch,
    }));
  }
}
