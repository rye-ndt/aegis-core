CREATE TABLE "prediction_market_findings" (
	"finding_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"pattern_type" text NOT NULL,
	"markets_involved" jsonb NOT NULL,
	"current_state" jsonb NOT NULL,
	"live_odds" jsonb NOT NULL,
	"why_anomalous" text NOT NULL,
	"side_a" jsonb NOT NULL,
	"side_b" jsonb NOT NULL,
	"confidence" text NOT NULL,
	"magnitude_bps" integer NOT NULL,
	"rank_score" integer NOT NULL,
	"rationale" text NOT NULL,
	"created_at_epoch" bigint NOT NULL,
	"broadcasted_at_epoch" bigint
);
--> statement-breakpoint
CREATE INDEX "pm_findings_by_run" ON "prediction_market_findings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "pm_findings_by_cluster" ON "prediction_market_findings" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "pm_findings_by_created" ON "prediction_market_findings" USING btree ("created_at_epoch");