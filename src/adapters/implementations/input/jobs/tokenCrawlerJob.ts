import type { ITokenIngestionUseCase } from "../../../../use-cases/interface/input/tokenIngestion.interface";
import { isWorker } from "../../../../helpers/env/role";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("tokenCrawlerJob");

export class TokenCrawlerJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tokenIngestionUseCase: ITokenIngestionUseCase,
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
    log.info({ step: "tick-start" }, "triggering token ingestion");
    this.tokenIngestionUseCase.ingest(this.chainId).then(() => {
      log.info({ step: "tick-end", durationMs: Date.now() - start }, "token ingestion complete");
    }).catch((err) => {
      log.error({ err }, "ingestion error");
    });
  }
}
