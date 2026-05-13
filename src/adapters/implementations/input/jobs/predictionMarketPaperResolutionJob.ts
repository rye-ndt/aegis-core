/**
 * Periodic paper-bet resolution job. Mirrors `predictionMarketScanJob`:
 * single-leader Redis lock so only one worker in the fleet ticks at a time;
 * exceptions are logged but never crash the worker (next tick retries).
 */

import type Redis from "ioredis";
import { isWorker } from "../../../../helpers/env/role";
import { createLogger } from "../../../../helpers/observability/logger";
import { newUuid } from "../../../../helpers/uuid";
import type { PredictionMarketPaperResolutionUseCase } from "../../../../use-cases/implementations/predictionMarketPaperResolution.usecase";

const log = createLogger("predictionMarketPaperResolutionJob");

const LOCK_KEY = "pm:paper-resolution:lock";

export class PredictionMarketPaperResolutionJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly useCase: PredictionMarketPaperResolutionUseCase,
    private readonly redis: Redis,
    private readonly intervalMs: number,
    private readonly lockTtlMs: number,
  ) {}

  start(): void {
    if (!isWorker()) {
      log.info("not a worker role — not starting.");
      return;
    }
    log.info(
      { intervalMs: this.intervalMs, lockTtlMs: this.lockTtlMs },
      "paper-resolution job starting",
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
    this.runWithLock().catch((err) => log.error({ err }, "paper-resolution tick error"));
  }

  private async runWithLock(): Promise<void> {
    const reqId = newUuid().slice(0, 8);
    // SET NX PX — only one worker in the fleet runs each tick.
    const acquired = await this.redis.set(LOCK_KEY, reqId, "PX", this.lockTtlMs, "NX");
    if (acquired !== "OK") {
      log.debug({ reqId }, "paper-resolution lock held — skipping");
      return;
    }
    try {
      await this.useCase.tick(reqId);
    } catch (err) {
      log.error({ err, reqId }, "paper-resolution tick failed");
    } finally {
      try {
        const current = await this.redis.get(LOCK_KEY);
        if (current === reqId) await this.redis.del(LOCK_KEY);
      } catch (err) {
        log.warn({ err, reqId }, "paper-resolution lock release failed");
      }
    }
  }
}
