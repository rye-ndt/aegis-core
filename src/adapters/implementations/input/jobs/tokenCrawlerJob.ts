import type { ITokenIngestionUseCase } from "../../../../use-cases/interface/input/tokenIngestion.interface";
import { isWorker } from "../../../../helpers/env/role";

export class TokenCrawlerJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tokenIngestionUseCase: ITokenIngestionUseCase,
    private readonly chainId: number,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (!isWorker()) {
      console.log("[TokenCrawlerJob] not a worker role — not starting.");
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
    console.log("[TokenCrawlerJob] triggering token ingestion...");
    this.tokenIngestionUseCase.ingest(this.chainId).catch((err) => {
      console.error("[TokenCrawlerJob] ingestion error:", err);
    });
  }
}
