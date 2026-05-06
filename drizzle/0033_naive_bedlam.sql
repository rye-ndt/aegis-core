CREATE TABLE "prediction_market_clusters" (
	"cluster_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"theme" text NOT NULL,
	"causal_driver" text NOT NULL,
	"market_ids" jsonb NOT NULL,
	"expected_relationships" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"confidence" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_market_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"created_at_epoch" bigint NOT NULL,
	"universe_hash" text NOT NULL,
	"cluster_set_hash" text,
	"status" text NOT NULL,
	"is_latest" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_market_snapshots" (
	"run_id" uuid NOT NULL,
	"market_id" text NOT NULL,
	"slug" text NOT NULL,
	"question" text NOT NULL,
	"resolution_criteria" text NOT NULL,
	"category" text,
	"resolution_epoch_sec" bigint NOT NULL,
	"yes_price_bp" integer NOT NULL,
	"no_price_bp" integer NOT NULL,
	"open_interest_usd_cents" bigint NOT NULL,
	"volume_7d_usd_cents" bigint NOT NULL,
	"liquidity_usd_cents" bigint NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "pm_snapshots_run_market_uniq" UNIQUE("run_id","market_id")
);
--> statement-breakpoint
CREATE INDEX "pm_clusters_by_run" ON "prediction_market_clusters" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "pm_runs_created_at_idx" ON "prediction_market_runs" USING btree ("created_at_epoch");--> statement-breakpoint
CREATE INDEX "pm_runs_is_latest_idx" ON "prediction_market_runs" USING btree ("is_latest");--> statement-breakpoint
CREATE INDEX "pm_snapshots_by_run" ON "prediction_market_snapshots" USING btree ("run_id");