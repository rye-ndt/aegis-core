import type { IYieldOptimizerUseCase } from "../../../../use-cases/interface/yield/IYieldOptimizerUseCase";
import { isWorker } from "../../../../helpers/env/role";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("yieldPoolScanJob");

export class YieldPoolScanJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly optimizer: IYieldOptimizerUseCase,
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
    log.info({ step: "tick-start" }, "scanning pools");
    this.optimizer.runPoolScan().then(() => {
      log.info({ step: "tick-end", durationMs: Date.now() - start }, "pool scan complete");
    }).catch((err) => {
      log.error({ err }, "pool scan error");
    });
  }
}
