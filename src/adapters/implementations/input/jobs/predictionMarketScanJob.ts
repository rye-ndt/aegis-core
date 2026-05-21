import type Redis from "ioredis";
import { PREDICTION_MARKETS_ENV } from "../../../../helpers/env/predictionMarketEnv";
import { isWorker } from "../../../../helpers/env/role";
import { createLogger } from "../../../../helpers/observability/logger";
import { parseCutOverSubjects } from "../../../../use-cases/interface/predictionMarket/marketFactVocabularies";
import { newUuid } from "../../../../helpers/uuid";
import type { PredictionMarketScanUseCase } from "../../../../use-cases/implementations/predictionMarketScan.usecase";

const log = createLogger("predictionMarketScanJob");

const LOCK_KEY = "pm:scan:lock";

export class PredictionMarketScanJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly useCase: PredictionMarketScanUseCase,
    private readonly redis: Redis,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (!isWorker()) {
      log.info("not a worker role — not starting.");
      return;
    }
    // Single-shot feature-flag banner at startup so operators can verify
    // what the worker is actually doing without grepping multiple files.
    const cutOver = parseCutOverSubjects(PREDICTION_MARKETS_ENV.deterministicSubjects);
    log.info(
      {
        intervalMs: this.intervalMs,
        flags: {
          scanEnabled: PREDICTION_MARKETS_ENV.enabled,
          findingsEnabled: PREDICTION_MARKETS_ENV.findingsEnabled,
          betsEnabled: PREDICTION_MARKETS_ENV.betsEnabled,
          shadowMode: PREDICTION_MARKETS_ENV.shadowMode,
          eventIdClusteringEnabled: PREDICTION_MARKETS_ENV.eventIdClusteringEnabled,
          sizingEnabled: PREDICTION_MARKETS_ENV.sizingEnabled,
          adminHttpTokenSet: !!PREDICTION_MARKETS_ENV.adminHttpToken,
          reviewAdminChatIdSet: !!PREDICTION_MARKETS_ENV.reviewAdminChatId,
        },
        deterministicSubjects: Array.from(cutOver),
        models: {
          classifier: PREDICTION_MARKETS_ENV.classifierModel,
          detector: PREDICTION_MARKETS_ENV.detectorModel,
          extractor: PREDICTION_MARKETS_ENV.extractorModel,
          promptVersion: PREDICTION_MARKETS_ENV.promptVersion,
        },
        // Phase A (2026-05-20 LLM-cost reduction) effective knobs — surfaced
        // at startup so operators can confirm the worker is running on the
        // cheaper defaults without grepping multiple files.
        llmCost: {
          classifierReasoningEffort: PREDICTION_MARKETS_ENV.classifierReasoningEffort,
          classifierMaxTokens: PREDICTION_MARKETS_ENV.classifierMaxTokens,
          detectorReasoningEffort: PREDICTION_MARKETS_ENV.detectorReasoningEffort,
          detectorMaxTokens: PREDICTION_MARKETS_ENV.detectorMaxTokens,
          detectorPriceBucketBps: PREDICTION_MARKETS_ENV.detectorPriceBucketBps,
          detectorCacheTtlSec: PREDICTION_MARKETS_ENV.detectorCacheTtlSec,
          reclusterDelta: PREDICTION_MARKETS_ENV.reclusterDelta,
        },
        sizer: PREDICTION_MARKETS_ENV.sizingEnabled
          ? {
              budgetUsdc: PREDICTION_MARKETS_ENV.sizerBudgetUsdc,
              feeBps: PREDICTION_MARKETS_ENV.sizerFeeBps,
              gasEstimateUsdc: PREDICTION_MARKETS_ENV.sizerGasEstimateUsdc,
              depthLevels: PREDICTION_MARKETS_ENV.sizerDepthLevels,
            }
          : undefined,
      },
      "prediction-market scan job starting",
    );
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    this.runWithLock().catch((err) => log.error({ err }, "scan tick error"));
  }

  private async runWithLock(): Promise<void> {
    const lockTtlMs = Math.max(60_000, Math.floor(this.intervalMs * 0.9));
    const reqId = newUuid().slice(0, 8);
    // SET NX PX — only one worker in the fleet runs each tick.
    const acquired = await this.redis.set(LOCK_KEY, reqId, "PX", lockTtlMs, "NX");
    if (acquired !== "OK") {
      log.debug({ reqId }, "scan lock held by another worker — skipping");
      return;
    }
    try {
      await this.useCase.runOnce(reqId);
    } catch (err) {
      log.error({ err, reqId }, "scan run failed");
    } finally {
      // Best-effort release; only delete if we still own it (avoids dropping
      // a lock acquired by the next tick after our long-running scan).
      try {
        const current = await this.redis.get(LOCK_KEY);
        if (current === reqId) await this.redis.del(LOCK_KEY);
      } catch (err) {
        log.warn({ err, reqId }, "scan lock release failed");
      }
    }
  }
}
