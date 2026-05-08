CREATE TABLE "prediction_market_bet_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"finding_id" uuid,
	"market_id" text NOT NULL,
	"side" text NOT NULL,
	"outcome_token_id" text,
	"stake_usdc_cents" bigint,
	"ref_price_bps" integer,
	"status" text NOT NULL,
	"bet_id" uuid,
	"expires_at_epoch" bigint NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_market_bets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"intent_id" uuid,
	"finding_id" uuid,
	"market_id" text NOT NULL,
	"outcome_token_id" text,
	"side" text NOT NULL,
	"stake_usdc_cents" bigint NOT NULL,
	"ref_price_bps" integer,
	"client_order_id" text NOT NULL,
	"bridge_intent_id" text,
	"sca_to_eoa_tx_hash" text,
	"polymarket_order_id" text,
	"status" text NOT NULL,
	"filled_shares" text,
	"filled_avg_price_bps" integer,
	"failure_reason" text,
	"bet_kind" text DEFAULT 'open' NOT NULL,
	"parent_bet_id" uuid,
	"refund_required" boolean DEFAULT false NOT NULL,
	"refund_tx_hash" text,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL,
	CONSTRAINT "prediction_market_bets_client_order_id_unique" UNIQUE("client_order_id")
);
--> statement-breakpoint
CREATE TABLE "prediction_market_positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"market_id" text NOT NULL,
	"outcome_token_id" text NOT NULL,
	"side" text NOT NULL,
	"size_shares" text NOT NULL,
	"entry_price_avg_bps" integer NOT NULL,
	"entry_stake_usdc_cents" bigint NOT NULL,
	"opening_bet_id" uuid,
	"closing_bet_id" uuid,
	"current_value_usdc_cents" bigint,
	"status" text NOT NULL,
	"resolved_outcome" text,
	"realized_pnl_usdc_cents" bigint,
	"opened_at_epoch" integer NOT NULL,
	"closed_at_epoch" integer
);
--> statement-breakpoint
CREATE TABLE "prediction_market_user_setup" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"polygon_sca_address" text NOT NULL,
	"polygon_eoa_address" text NOT NULL,
	"bootstrap_bridge_intent_id" text,
	"approvals_tx_hashes" jsonb,
	"polymarket_creds_enc" text,
	"setup_step" text NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prediction_market_user_setup" ADD CONSTRAINT "prediction_market_user_setup_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pm_bet_intents_by_user_status" ON "prediction_market_bet_intents" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "pm_bets_by_user_status" ON "prediction_market_bets" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "pm_bets_by_client_order_id" ON "prediction_market_bets" USING btree ("client_order_id");--> statement-breakpoint
CREATE INDEX "pm_positions_by_user_status" ON "prediction_market_positions" USING btree ("user_id","status");