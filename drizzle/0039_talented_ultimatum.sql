CREATE TABLE "prediction_market_extraction_reviews" (
	"review_id" uuid PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"proposed_fact" jsonb NOT NULL,
	"regex_failures" jsonb NOT NULL,
	"status" text NOT NULL,
	"resolution" jsonb,
	"created_at_epoch" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_market_facts" (
	"market_id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"operator" text NOT NULL,
	"threshold" text,
	"threshold_set" jsonb,
	"threshold_unit" text NOT NULL,
	"window_start" bigint,
	"window_end" bigint NOT NULL,
	"resolution_source" text NOT NULL,
	"resolution_method" text NOT NULL,
	"event_family" text NOT NULL,
	"polymarket_event_id" text,
	"extraction_model" text NOT NULL,
	"extraction_prompt_version" text NOT NULL,
	"extraction_at_epoch" bigint NOT NULL,
	"regex_verified" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prediction_market_snapshots" ADD COLUMN "polymarket_event_id" text;--> statement-breakpoint
CREATE INDEX "pm_reviews_by_status" ON "prediction_market_extraction_reviews" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pm_reviews_by_market" ON "prediction_market_extraction_reviews" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "pm_facts_by_event_family" ON "prediction_market_facts" USING btree ("event_family");--> statement-breakpoint
CREATE INDEX "pm_facts_by_subject" ON "prediction_market_facts" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "pm_facts_by_polymarket_event" ON "prediction_market_facts" USING btree ("polymarket_event_id");