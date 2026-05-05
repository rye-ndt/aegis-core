import type { IStockPairIngestionUseCase } from "../interface/input/stockPairIngestion.interface";
import type { IStockPairCrawler } from "../interface/output/stocks/stockPairCrawler.interface";
import type { IStockPairDB } from "../interface/output/repository/stockPair.repo";
import { newUuid } from "../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { createLogger } from "../../helpers/observability/logger";

const log = createLogger("stockPairIngestion");

/**
 * Mirrors `TokenIngestionUseCase`. The crawler returns the live pair set
 * with optional friendly names from SEC EDGAR; we upsert chain-derived
 * fields first (preserving any existing `name`), then write the friendly
 * name when one is available. Two-phase write is deliberate so a
 * future re-ingest cannot blank out a name when SEC EDGAR temporarily
 * fails — `setName` is only called on rows that have a non-empty name
 * from the crawler.
 */
export class StockPairIngestionUseCase implements IStockPairIngestionUseCase {
  constructor(
    private readonly crawler: IStockPairCrawler,
    private readonly stockPairDB: IStockPairDB,
  ) {}

  async ingest(chainId: number): Promise<void> {
    const start = Date.now();
    log.info({ step: "started", chainId }, "stock pair ingest started");
    let pairs;
    try {
      pairs = await this.crawler.fetchPairs(chainId);
    } catch (err) {
      log.error({ err, step: "failed", chainId }, "crawler fetchPairs threw");
      return;
    }

    if (pairs.length === 0) {
      log.warn({ step: "failed", chainId }, "no pairs returned, skipping upsert");
      return;
    }

    const now = newCurrentUTCEpoch();
    let upserted = 0;
    let named = 0;
    for (const p of pairs) {
      try {
        await this.stockPairDB.upsertChainFields({
          id: newUuid(),
          symbol: p.symbol,
          chainId,
          pairBase: p.pairBase,
          isActive: true,
          createdAtEpoch: now,
          updatedAtEpoch: now,
        });
        upserted++;
        if (p.name && p.name.trim().length > 0) {
          await this.stockPairDB.setName(p.symbol, chainId, p.name);
          named++;
        }
      } catch (err) {
        log.error({ err, symbol: p.symbol }, "stock pair upsert failed");
      }
    }
    log.info(
      {
        step: "succeeded",
        chainId,
        upserted,
        named,
        total: pairs.length,
        durationMs: Date.now() - start,
      },
      "stock pair ingest complete",
    );
  }
}
