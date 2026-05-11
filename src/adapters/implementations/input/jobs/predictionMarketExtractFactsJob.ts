import type Redis from "ioredis";
import { isWorker } from "../../../../helpers/env/role";
import { createLogger } from "../../../../helpers/observability/logger";
import { newUuid } from "../../../../helpers/uuid";
import type { PredictionMarketExtractFactsUseCase } from "../../../../use-cases/implementations/predictionMarketExtractFacts.usecase";
import type { IPredictionMarketRepository } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketRepository";

const log = createLogger("predictionMarketExtractFactsJob");

const LOCK_KEY = "pm:extract:lock";

export class PredictionMarketExtractFactsJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly useCase: PredictionMarketExtractFactsUseCase,
    private readonly repo: IPredictionMarketRepository,
    private readonly redis: Redis,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (!isWorker()) {
      log.info("not a worker role — not starting.");
      return;
    }
    log.info({ intervalMs: this.intervalMs }, "extract-facts job starting");
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
    this.runWithLock().catch((err) => log.error({ err }, "extract tick error"));
  }

  private async runWithLock(): Promise<void> {
    const lockTtlMs = Math.max(60_000, Math.floor(this.intervalMs * 0.9));
    const reqId = newUuid().slice(0, 8);
    const acquired = await this.redis.set(LOCK_KEY, reqId, "PX", lockTtlMs, "NX");
    if (acquired !== "OK") {
      log.debug({ reqId }, "extract lock held by another worker — skipping");
      return;
    }
    try {
      const latest = await this.repo.getLatestRun();
      if (!latest) {
        log.debug({ reqId }, "no latest run — skipping");
        return;
      }
      const markets = await this.repo.getMarketsByRun(latest.runId);
      await this.useCase.runOnce(markets, reqId);
    } catch (err) {
      log.error({ err, reqId }, "extract run failed");
    } finally {
      try {
        const current = await this.redis.get(LOCK_KEY);
        if (current === reqId) await this.redis.del(LOCK_KEY);
      } catch (err) {
        log.warn({ err, reqId }, "extract lock release failed");
      }
    }
  }
}
