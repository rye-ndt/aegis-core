import { createHash } from "crypto";
import { PREDICTION_MARKETS_ENV } from "../../helpers/env/predictionMarketEnv";
import { createLogger } from "../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import { toClassifierRecord } from "../interface/predictionMarket/IPredictionMarketClassifier";
import type { IPredictionMarketBroadcaster } from "../interface/predictionMarket/IPredictionMarketBroadcaster";
import type { IPredictionMarketClassifier } from "../interface/predictionMarket/IPredictionMarketClassifier";
import type { IPredictionMarketProvider } from "../interface/predictionMarket/IPredictionMarketProvider";
import type { IPredictionMarketRepository } from "../interface/predictionMarket/IPredictionMarketRepository";
import type {
  DraftCluster,
  RawMarket,
  RunOutcome,
  StoredCluster,
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

export class PredictionMarketScanUseCase {
  constructor(
    private readonly provider: IPredictionMarketProvider,
    private readonly classifier: IPredictionMarketClassifier,
    private readonly repo: IPredictionMarketRepository,
    private readonly broadcaster: IPredictionMarketBroadcaster | null,
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
      return { runId: "", fetched: 0, clusters: 0, published: 0, broadcast: false };
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
      log.info({ step: "classify-skipped", reqId, clusters: clusters.length }, "scan");
    }

    await this.repo.insertClusters(runId, clusters);

    for (const c of clusters) {
      if (c.confidence === "medium") {
        log.warn({ reqId, theme: c.theme, marketCount: c.marketIds.length }, "cluster medium-confidence pending review");
      }
    }
    const published = clusters.filter((c) => c.confidence === "high");

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

    log.info(
      {
        step: "tick-end",
        reqId,
        runId,
        fetched: markets.length,
        clusters: clusters.length,
        published: published.length,
        broadcast,
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
    };
  }
}
