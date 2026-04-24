import type Redis from "ioredis";
import { isWorker } from "../../../../helpers/env/role";
import type { IYieldOptimizerUseCase, DailyReport } from "../../../../use-cases/interface/yield/IYieldOptimizerUseCase";
import type { IYieldRepository } from "../../../../use-cases/interface/yield/IYieldRepository";

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const REPORT_DONE_TTL_SEC = 25 * 60 * 60;

export class YieldReportJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly optimizer: IYieldOptimizerUseCase,
    private readonly yieldRepo: IYieldRepository,
    private readonly redis: Redis,
    private readonly reportUtcHour: number,
    private readonly sendReport: (userId: string, chatId: string, report: DailyReport) => Promise<void>,
    private readonly getChatId: (userId: string) => Promise<string | null>,
  ) {}

  start(): void {
    if (!isWorker()) {
      console.log("[YieldReportJob] not a worker role — not starting.");
      return;
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    this.maybeRunReports().catch((err) => {
      console.error("[YieldReportJob] error:", err);
    });
  }

  private async maybeRunReports(): Promise<void> {
    const nowUtcHour = new Date().getUTCHours();
    if (nowUtcHour !== this.reportUtcHour) return;

    const today = new Date().toISOString().slice(0, 10);
    const doneKey = this.optimizer.reportDoneRedisKey(today);
    const alreadyDone = await this.redis.exists(doneKey);
    if (alreadyDone) return;

    console.log("[YieldReportJob] sending daily reports...");

    const userIds = await this.yieldRepo.listUsersWithPositions();
    for (const userId of userIds) {
      try {
        const report: DailyReport | null = await this.optimizer.buildDailyReport(userId);
        if (!report) continue;

        const chatId = await this.getChatId(userId);
        if (!chatId) continue;

        await this.sendReport(userId, chatId, report);
      } catch (err) {
        console.error(`[YieldReportJob] userId=${userId}:`, err);
      }
    }

    await this.redis.set(doneKey, "1", "EX", REPORT_DONE_TTL_SEC);
  }
}
