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
import type {
  DraftCluster,
  RawMarket,
  RunOutcome,
  StoredCluster,
  VerifiedFinding,
} from "../interface/predictionMarket/PredictionMarketTypes";

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

function carryForward(stored: StoredCluster[]): DraftCluster[] {
  return stored.map((s) => ({
    theme: s.theme,
    causalDriver: s.causalDriver,
    marketIds: s.marketIds,
    expectedRelationships: s.expectedRelationships,
    rationale: s.rationale,
    confidence: s.confidence,
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

    let clusters: DraftCluster[];
    // Carry-forward keeps the prior run's clusterId so the stage-3 detector
    // cache and `prediction_market_findings.cluster_id` remain stable.
    let priorClusterIdByContent: Map<string, string> | null = null;
    if (shouldRecluster) {
      log.info({ step: "classify-start", reqId, marketCount: markets.length }, "scan");
      clusters = await this.classifier.classify({
        markets: markets.map(toClassifierRecord),
        reqId,
      });
      log.info({ step: "classify-end", reqId, clusters: clusters.length }, "scan");
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
      const perCluster = await Promise.all(
        publishedStored.map((cluster) =>
          stage3Limit(() => this.runStage3ForCluster(cluster, marketById, runId, reqId)),
        ),
      );

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
  ): Promise<{ drafts: number; verified: VerifiedFinding[] }> {
    if (!this.detector || !this.verifier) return { drafts: 0, verified: [] };
    const members: RawMarket[] = [];
    for (const id of cluster.marketIds) {
      const m = marketById.get(id);
      if (m) members.push(m);
    }
    if (members.length < 2) return { drafts: 0, verified: [] };
    try {
      const drafts = await this.detector.detect({ cluster, members, reqId });
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
}
