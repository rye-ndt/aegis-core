import type Redis from "ioredis";
import pLimit from "p-limit";
import { isWorker } from "../../../../helpers/env/role";
import { createLogger } from "../../../../helpers/observability/logger";
import { newUuid } from "../../../../helpers/uuid";
import type { IPredictionMarketBetRepository } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketBetRepository";
import type { IPredictionMarketBetUseCase } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketBetUseCase";
import type { IPredictionMarketReceiptBroadcaster } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketReceiptBroadcaster";

const log = createLogger("polymarketPositionPollerJob");

const LOCK_KEY = "pm:position-poller:lock";

export interface PolymarketPositionPollerDeps {
  betUseCase: IPredictionMarketBetUseCase;
  betRepo: IPredictionMarketBetRepository;
  receiptBroadcaster: IPredictionMarketReceiptBroadcaster;
  redis: Redis;
  intervalMs: number;
  /** Bounded fan-out across users in a tick. */
  concurrency: number;
}

/**
 * Manual closes via Polymarket web surface as `closedFromPolymarket` from the
 * use-case — we settle the local row silently (no receipt push) because there
 * is no clean fill price to render.
 */
export class PolymarketPositionPollerJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PolymarketPositionPollerDeps) {}

  start(): void {
    if (!isWorker()) {
      log.info("not a worker role — not starting.");
      return;
    }
    log.info({ intervalMs: this.deps.intervalMs }, "position poller starting");
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
    let userCount = 0;
    let positionsReconciled = 0;
    let divergencesFixed = 0;
    let resolvedCount = 0;
    try {
      const users = await this.deps.betRepo.listUsersWithOpenPositions();
      userCount = users.length;
      log.info({ step: "tick-start", reqId, userCount }, "reconcile");

      const limit = pLimit(this.deps.concurrency);
      await Promise.all(
        users.map((u) =>
          limit(async () => {
            if (!u.polymarketCredsEnc) {
              log.debug({ userId: u.userId, reqId }, "skip — no creds");
              return;
            }
            try {
              const result = await this.deps.betUseCase.reconcileUserPositions({
                userId: u.userId,
                makerAddress: u.polygonEoaAddress as `0x${string}`,
                polymarketCredsEnc: u.polymarketCredsEnc,
              });
              positionsReconciled += result.marked.length;
              divergencesFixed +=
                result.resolved.length +
                result.marked.length +
                result.closedFromPolymarket.length;
              resolvedCount += result.resolved.length;

              for (const pos of result.resolved) {
                try {
                  await this.deps.receiptBroadcaster.broadcastPositionResolved({
                    userId: u.userId,
                    position: pos,
                  });
                } catch (err) {
                  log.warn({ err, userId: u.userId, positionId: pos.id }, "broadcast-resolved-failed");
                }
              }
            } catch (err) {
              log.error({ err, userId: u.userId, reqId }, "per-user reconcile failed");
            }
          }),
        ),
      );

      log.info(
        {
          step: "tick-end",
          reqId,
          userCount,
          positionsReconciled,
          divergencesFixed,
          resolvedCount,
          durationMs: Date.now() - start,
        },
        "reconcile",
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
