CREATE TABLE "prediction_market_findings_shadow" (
	"shadow_finding_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"shadow_cluster_id" uuid,
	"real_cluster_id" uuid,
	"pipeline" text NOT NULL,
	"pattern_type" text NOT NULL,
	"markets_involved" jsonb NOT NULL,
	"live_odds" jsonb NOT NULL,
	"magnitude_bps" integer NOT NULL,
	"wider_market_id" text,
	"narrower_market_id" text,
	"earlier_market_id" text,
	"later_market_id" text,
	"rationale" text NOT NULL,
	"confidence" text NOT NULL,
	"created_at_epoch" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pm_findings_shadow_by_run" ON "prediction_market_findings_shadow" USING btree ("run_id");