import type { MarketFact } from "./MarketFactTypes";
import type { RegexFailure } from "./IPredictionMarketExtractor";

export type ReviewStatus = "pending" | "approved" | "rejected";

export interface ReviewResolution {
  status: Exclude<ReviewStatus, "pending">;
  notes?: string;
  resolvedAtEpoch: number;
  resolvedByChatId: string | null;
}

export interface ReviewRow {
  reviewId: string;
  marketId: string;
  proposedFact: MarketFact;
  regexFailures: RegexFailure[];
  status: ReviewStatus;
  resolution: ReviewResolution | null;
  createdAtEpoch: number;
}

export interface InsertReviewInput {
  reviewId: string;
  marketId: string;
  proposedFact: MarketFact;
  regexFailures: RegexFailure[];
  createdAtEpoch: number;
}

export interface IPredictionMarketFactRepository {
  getByMarketId(marketId: string): Promise<MarketFact | null>;
  getByMarketIds(marketIds: string[]): Promise<Map<string, MarketFact>>;
  upsertFact(fact: MarketFact): Promise<void>;
  insertReview(input: InsertReviewInput): Promise<void>;
  getReview(reviewId: string): Promise<ReviewRow | null>;
  resolveReview(reviewId: string, resolution: ReviewResolution): Promise<void>;
  listPendingReviews(): Promise<ReviewRow[]>;
}
