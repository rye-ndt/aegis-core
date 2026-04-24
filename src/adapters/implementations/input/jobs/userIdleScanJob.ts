import type { IYieldOptimizerUseCase } from "../../../../use-cases/interface/yield/IYieldOptimizerUseCase";
import type { ITelegramSessionDB } from "../../../../use-cases/interface/output/repository/telegramSession.repo";
import { isWorker } from "../../../../helpers/env/role";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("userIdleScanJob");
const CONCURRENCY = 5;

async function runWithConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  limit: number,
): Promise<void> {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += limit) {
    chunks.push(items.slice(i, i + limit));
  }
  for (const chunk of chunks) {
    await Promise.allSettled(chunk.map(fn));
  }
}

export class UserIdleScanJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly optimizer: IYieldOptimizerUseCase,
    private readonly telegramSessionRepo: ITelegramSessionDB,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (!isWorker()) {
      log.info("not a worker role — not starting.");
      return;
    }
    this.run();
    this.timer = setInterval(() => this.run(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private run(): void {
    const start = Date.now();
    log.info({ step: "tick-start" }, "scanning idle balances");
    this.scanAll().then(() => {
      log.info({ step: "tick-end", durationMs: Date.now() - start }, "idle scan complete");
    }).catch((err) => {
      log.error({ err }, "idle scan error");
    });
  }

  private async scanAll(): Promise<void> {
    const activeUserIds = await this.telegramSessionRepo.listActiveUserIds();
    const uniqueUserIds = new Set<string>(activeUserIds);

    const userIds = Array.from(uniqueUserIds);

    await runWithConcurrency(
      userIds,
      async (userId) => {
        try {
          await this.optimizer.scanIdleForUser(userId);
        } catch (err) {
          log.error({ err, userId }, "per-user idle scan error");
        }
      },
      CONCURRENCY,
    );
  }
}
