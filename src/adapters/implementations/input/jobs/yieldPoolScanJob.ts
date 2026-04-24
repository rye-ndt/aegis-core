import type { IYieldOptimizerUseCase } from "../../../../use-cases/interface/yield/IYieldOptimizerUseCase";
import { isWorker } from "../../../../helpers/env/role";

export class YieldPoolScanJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly optimizer: IYieldOptimizerUseCase,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (!isWorker()) {
      console.log("[YieldPoolScanJob] not a worker role — not starting.");
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
    console.log("[YieldPoolScanJob] scanning pools...");
    this.optimizer.runPoolScan().catch((err) => {
      console.error("[YieldPoolScanJob] error:", err);
    });
  }
}
