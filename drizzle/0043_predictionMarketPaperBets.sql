CREATE TABLE "prediction_market_paper_bets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"market_id" text NOT NULL,
	"subject" text,
	"side" text NOT NULL,
	"stake_usdc_cents" integer NOT NULL,
	"entry_price_bps" integer NOT NULL,
	"shares_e6" bigint NOT NULL,
	"detector_source" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"outcome" text,
	"payout_usdc_cents" integer,
	"realized_pnl_usdc_cents" integer,
	"entry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "prediction_market_paper_bets" ADD CONSTRAINT "prediction_market_paper_bets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market_paper_bets" ADD CONSTRAINT "prediction_market_paper_bets_finding_id_prediction_market_findings_finding_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."prediction_market_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_bets_user_status_idx" ON "prediction_market_paper_bets" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "paper_bets_finding_idx" ON "prediction_market_paper_bets" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "paper_bets_market_status_idx" ON "prediction_market_paper_bets" USING btree ("market_id","status");--> statement-breakpoint
CREATE INDEX "paper_bets_subject_idx" ON "prediction_market_paper_bets" USING btree ("subject");