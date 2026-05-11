CREATE TABLE "prediction_market_clusters_shadow" (
	"shadow_cluster_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"pipeline" text NOT NULL,
	"derived_subject" text,
	"theme" text NOT NULL,
	"causal_driver" text NOT NULL,
	"market_ids" jsonb NOT NULL,
	"expected_relationships" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"confidence" text NOT NULL,
	"created_at_epoch" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prediction_market_clusters" ADD COLUMN "derived_subject" text;--> statement-breakpoint
CREATE INDEX "pm_clusters_shadow_by_run" ON "prediction_market_clusters_shadow" USING btree ("run_id");