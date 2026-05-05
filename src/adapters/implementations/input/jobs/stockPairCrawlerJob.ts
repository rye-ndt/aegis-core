import type { IStockPairIngestionUseCase } from "../../../../use-cases/interface/input/stockPairIngestion.interface";
import { isWorker } from "../../../../helpers/env/role";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("stockPairCrawlerJob");

/**
 * Worker-only cron that re-syncs the on-venue stock pair list into the DB.
 * Mirrors `TokenCrawlerJob` — single timer, fire-on-boot then interval.
 */
export class StockPairCrawlerJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ingestionUseCase: IStockPairIngestionUseCase,
    private readonly chainId: number,
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
    log.info({ step: "tick-start", chainId: this.chainId }, "triggering stock pair ingest");
    this.ingestionUseCase
      .ingest(this.chainId)
      .then(() => {
        log.info(
          { step: "tick-end", durationMs: Date.now() - start },
          "stock pair ingest complete",
        );
      })
      .catch((err) => {
        log.error({ err }, "stock pair ingest error");
      });
  }
}
