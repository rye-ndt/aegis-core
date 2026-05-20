import type Redis from "ioredis";
import { isWorker } from "../../../../helpers/env/role";
import { PREDICTION_MARKETS_ENV } from "../../../../helpers/env/predictionMarketEnv";
import { createLogger } from "../../../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type { IPredictionMarketBetUseCase } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketBetUseCase";

const log = createLogger("predictionMarketStuckBetSweeperJob");

const LOCK_KEY = "pm:stuck-bet-sweeper:lock";

export interface PredictionMarketStuckBetSweeperDeps {
  betUseCase: IPredictionMarketBetUseCase;
  redis: Redis;
  intervalMs: number;
  stuckTimeoutMs: number;
}

// Re-enqueues lapsed sign-requests for bets whose mini-app went away
// mid-flow. Idempotent — the use-case's per-(bet, slot) NX lock means a
// re-advance produces at most one open sign-request.
export class PredictionMarketStuckBetSweeperJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PredictionMarketStuckBetSweeperDeps) {}

  start(): void {
    if (!isWorker()) {
      log.info("not a worker role — not starting.");
      return;
    }
    if (!PREDICTION_MARKETS_ENV.useSignQueue) {
      log.info("PREDICTION_MARKETS_USE_SIGN_QUEUE=false — not starting.");
      return;
    }
    log.info({ intervalMs: this.deps.intervalMs }, "stuck-bet sweeper starting");
    this.tick();
    this.timer = setInterval(() => this.tick(), this.deps.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    this.runWithLock().catch((err) => log.error({ err }, "tick error"));
  }

  private async runWithLock(): Promise<void> {
    const lockTtlMs = Math.max(60_000, Math.floor(this.deps.intervalMs * 0.9));
    const reqId = newUuid().slice(0, 8);
    const acquired = await this.deps.redis.set(LOCK_KEY, reqId, "PX", lockTtlMs, "NX");
    if (acquired !== "OK") {
      log.debug({ reqId }, "lock held — skipping");
      return;
    }
    const start = Date.now();
    try {
      const olderThanEpoch =
        newCurrentUTCEpoch() - Math.floor(this.deps.stuckTimeoutMs / 1000);
      log.info({ step: "tick-start", reqId, olderThanEpoch }, "sweep");
      const swept = await this.deps.betUseCase.sweepStuckBets(olderThanEpoch);
      log.info(
        { step: "tick-end", reqId, swept, durationMs: Date.now() - start },
        "sweep",
      );
    } catch (err) {
      log.error({ err, reqId }, "tick failed");
    } finally {
      try {
        const current = await this.deps.redis.get(LOCK_KEY);
        if (current === reqId) await this.deps.redis.del(LOCK_KEY);
      } catch (err) {
        log.warn({ err, reqId }, "lock release failed");
      }
    }
  }
}
