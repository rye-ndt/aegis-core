import pLimit from "p-limit";
import { createLogger } from "../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import type { IPredictionMarketExtractor } from "../interface/predictionMarket/IPredictionMarketExtractor";
import type { IPredictionMarketFactRepository } from "../interface/predictionMarket/IPredictionMarketFactRepository";
import type { RawMarket } from "../interface/predictionMarket/PredictionMarketTypes";

const log = createLogger("predictionMarketExtractFacts");

export interface ExtractFactsOutcome {
  considered: number;
  skipped: number;
  verified: number;
  review: number;
  failed: number;
}

export type ReviewNotifier = (args: {
  reqId: string;
  reviewId: string;
  market: RawMarket;
  proposedFactSummary: string;
  failureSummary: string;
}) => Promise<void>;

export interface PredictionMarketExtractFactsConfig {
  concurrency: number;
}

export class PredictionMarketExtractFactsUseCase {
  constructor(
    private readonly extractor: IPredictionMarketExtractor,
    private readonly facts: IPredictionMarketFactRepository,
    private readonly cfg: PredictionMarketExtractFactsConfig,
    private readonly notifyReview?: ReviewNotifier,
  ) {}

  async runOnce(markets: RawMarket[], reqId: string): Promise<ExtractFactsOutcome> {
    const start = Date.now();
    log.info({ step: "started", reqId, candidates: markets.length }, "extract-facts");

    if (markets.length === 0) {
      return { considered: 0, skipped: 0, verified: 0, review: 0, failed: 0 };
    }

    const existing = await this.facts.getByMarketIds(markets.map((m) => m.marketId));
    const toExtract = markets.filter((m) => !existing.has(m.marketId));
    const skipped = markets.length - toExtract.length;

    let verified = 0;
    let review = 0;
    let failed = 0;

    const limit = pLimit(Math.max(1, this.cfg.concurrency));
    await Promise.all(
      toExtract.map((market) =>
        limit(async () => {
          const outcome = await this.extractor.extract({ market, reqId });
          if (outcome.kind === "verified") {
            await this.facts.upsertFact(outcome.fact);
            verified += 1;
            return;
          }
          if (outcome.kind === "review") {
            const reviewId = newUuid();
            await this.facts.insertReview({
              reviewId,
              marketId: market.marketId,
              proposedFact: outcome.proposedFact,
              regexFailures: outcome.regexFailures,
              createdAtEpoch: newCurrentUTCEpoch(),
            });
            review += 1;
            if (this.notifyReview) {
              try {
                const f = outcome.proposedFact;
                await this.notifyReview({
                  reqId,
                  reviewId,
                  market,
                  proposedFactSummary:
                    `subject=${f.subject} op=${f.operator} threshold=${formatThreshold(f.threshold, f.thresholdSet)} window_end=${f.windowEnd} source=${f.resolutionSource}`,
                  failureSummary: outcome.regexFailures
                    .map((rf) => `${rf.field} (${rf.reason})`)
                    .join("; "),
                });
              } catch (err) {
                log.warn({ err, reqId, reviewId, marketId: market.marketId }, "review-notify-failed");
              }
            }
            return;
          }
          failed += 1;
        }),
      ),
    );

    log.info(
      {
        step: "succeeded",
        reqId,
        considered: markets.length,
        skipped,
        verified,
        review,
        failed,
        durationMs: Date.now() - start,
      },
      "extract-facts",
    );

    return { considered: markets.length, skipped, verified, review, failed };
  }
}

function formatThreshold(
  threshold: number | string | null,
  thresholdSet: string[] | null,
): string {
  if (thresholdSet && thresholdSet.length > 0) return `{${thresholdSet.join(",")}}`;
  if (threshold === null) return "null";
  return String(threshold);
}
