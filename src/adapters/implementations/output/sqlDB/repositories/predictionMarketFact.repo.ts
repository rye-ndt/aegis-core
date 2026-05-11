import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IPredictionMarketFactRepository,
  InsertReviewInput,
  ReviewResolution,
  ReviewRow,
  ReviewStatus,
} from "../../../../../use-cases/interface/predictionMarket/IPredictionMarketFactRepository";
import type { RegexFailure } from "../../../../../use-cases/interface/predictionMarket/IPredictionMarketExtractor";
import type {
  MarketFact,
  Operator,
  ResolutionMethod,
  ThresholdUnit,
} from "../../../../../use-cases/interface/predictionMarket/MarketFactTypes";
import type {
  ResolutionSourceCode,
  SubjectCode,
} from "../../../../../use-cases/interface/predictionMarket/marketFactVocabularies";
import {
  predictionMarketExtractionReviews,
  predictionMarketFacts,
} from "../schema";

type FactRow = typeof predictionMarketFacts.$inferSelect;
type ReviewDbRow = typeof predictionMarketExtractionReviews.$inferSelect;

function factFromRow(row: FactRow): MarketFact {
  return {
    marketId: row.marketId,
    subject: row.subject as SubjectCode,
    operator: row.operator as Operator,
    threshold: parseThreshold(row.threshold),
    thresholdSet: (row.thresholdSet as string[] | null) ?? null,
    thresholdUnit: row.thresholdUnit as ThresholdUnit,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    resolutionSource: row.resolutionSource as ResolutionSourceCode,
    resolutionMethod: row.resolutionMethod as ResolutionMethod,
    eventFamily: row.eventFamily,
    polymarketEventId: row.polymarketEventId,
    extractionModel: row.extractionModel,
    extractionPromptVersion: row.extractionPromptVersion,
    extractionAtEpoch: row.extractionAtEpoch,
    regexVerified: row.regexVerified,
  };
}

function thresholdToColumn(t: number | string | null): string | null {
  if (t === null) return null;
  return typeof t === "number" ? `n:${t}` : `s:${t}`;
}

function parseThreshold(raw: string | null): number | string | null {
  if (raw === null) return null;
  if (raw.startsWith("n:")) {
    const n = Number(raw.slice(2));
    return Number.isFinite(n) ? n : null;
  }
  if (raw.startsWith("s:")) return raw.slice(2);
  // Back-compat with raw strings.
  const asNum = Number(raw);
  return Number.isFinite(asNum) ? asNum : raw;
}

function reviewFromRow(row: ReviewDbRow): ReviewRow {
  return {
    reviewId: row.reviewId,
    marketId: row.marketId,
    proposedFact: row.proposedFact as MarketFact,
    regexFailures: (row.regexFailures as RegexFailure[]) ?? [],
    status: row.status as ReviewStatus,
    resolution: (row.resolution as ReviewResolution | null) ?? null,
    createdAtEpoch: row.createdAtEpoch,
  };
}

export class DrizzlePredictionMarketFactRepo implements IPredictionMarketFactRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async getByMarketId(marketId: string): Promise<MarketFact | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketFacts)
      .where(eq(predictionMarketFacts.marketId, marketId))
      .limit(1);
    const row = rows[0];
    return row ? factFromRow(row) : null;
  }

  async getByMarketIds(marketIds: string[]): Promise<Map<string, MarketFact>> {
    const out = new Map<string, MarketFact>();
    if (marketIds.length === 0) return out;
    const rows = await this.db
      .select()
      .from(predictionMarketFacts)
      .where(inArray(predictionMarketFacts.marketId, marketIds));
    for (const r of rows) out.set(r.marketId, factFromRow(r));
    return out;
  }

  async upsertFact(fact: MarketFact): Promise<void> {
    const values = {
      marketId: fact.marketId,
      subject: fact.subject,
      operator: fact.operator,
      threshold: thresholdToColumn(fact.threshold),
      thresholdSet: fact.thresholdSet,
      thresholdUnit: fact.thresholdUnit,
      windowStart: fact.windowStart,
      windowEnd: fact.windowEnd,
      resolutionSource: fact.resolutionSource,
      resolutionMethod: fact.resolutionMethod,
      eventFamily: fact.eventFamily,
      polymarketEventId: fact.polymarketEventId,
      extractionModel: fact.extractionModel,
      extractionPromptVersion: fact.extractionPromptVersion,
      extractionAtEpoch: fact.extractionAtEpoch,
      regexVerified: fact.regexVerified,
    };
    await this.db
      .insert(predictionMarketFacts)
      .values(values)
      .onConflictDoUpdate({
        target: predictionMarketFacts.marketId,
        set: values,
      });
  }

  async insertReview(input: InsertReviewInput): Promise<void> {
    await this.db.insert(predictionMarketExtractionReviews).values({
      reviewId: input.reviewId,
      marketId: input.marketId,
      proposedFact: input.proposedFact,
      regexFailures: input.regexFailures,
      status: "pending" satisfies ReviewStatus,
      resolution: null,
      createdAtEpoch: input.createdAtEpoch,
    });
  }

  async getReview(reviewId: string): Promise<ReviewRow | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketExtractionReviews)
      .where(eq(predictionMarketExtractionReviews.reviewId, reviewId))
      .limit(1);
    return rows[0] ? reviewFromRow(rows[0]) : null;
  }

  async resolveReview(reviewId: string, resolution: ReviewResolution): Promise<void> {
    await this.db
      .update(predictionMarketExtractionReviews)
      .set({ status: resolution.status, resolution })
      .where(eq(predictionMarketExtractionReviews.reviewId, reviewId));
  }

  async listPendingReviews(): Promise<ReviewRow[]> {
    const rows = await this.db
      .select()
      .from(predictionMarketExtractionReviews)
      .where(eq(predictionMarketExtractionReviews.status, "pending"));
    return rows.map(reviewFromRow);
  }
}
