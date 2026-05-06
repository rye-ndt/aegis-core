import type Redis from "ioredis";
import { isWorker } from "../../../../helpers/env/role";
import { createLogger } from "../../../../helpers/observability/logger";
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
    log.info({ intervalMs: this.intervalMs }, "prediction-market scan job starting");
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
