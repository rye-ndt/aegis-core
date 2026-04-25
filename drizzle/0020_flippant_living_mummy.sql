CREATE TABLE "loyalty_action_types" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"default_base" bigint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at_epoch" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_points_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"season_id" text NOT NULL,
	"action_type" text NOT NULL,
	"points_raw" bigint NOT NULL,
	"intent_execution_id" uuid,
	"external_ref" text,
	"formula_version" text NOT NULL,
	"computed_from_json" jsonb NOT NULL,
	"metadata_json" jsonb,
	"created_at_epoch" integer NOT NULL,
	CONSTRAINT "loyalty_ledger_intent_execution_uniq" UNIQUE("intent_execution_id"),
	CONSTRAINT "loyalty_ledger_user_action_ref_uniq" UNIQUE("user_id","action_type","external_ref")
);
--> statement-breakpoint
CREATE TABLE "loyalty_seasons" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"starts_at_epoch" integer NOT NULL,
	"ends_at_epoch" integer NOT NULL,
	"status" text NOT NULL,
	"formula_version" text NOT NULL,
	"config_json" jsonb NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "loyalty_status" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_points_ledger" ADD CONSTRAINT "loyalty_points_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_points_ledger" ADD CONSTRAINT "loyalty_points_ledger_season_id_loyalty_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."loyalty_seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_points_ledger" ADD CONSTRAINT "loyalty_points_ledger_action_type_loyalty_action_types_id_fk" FOREIGN KEY ("action_type") REFERENCES "public"."loyalty_action_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loyalty_points_ledger_user_id_season_id_index" ON "loyalty_points_ledger" USING btree ("user_id","season_id");--> statement-breakpoint
CREATE INDEX "loyalty_points_ledger_season_id_points_raw_index" ON "loyalty_points_ledger" USING btree ("season_id","points_raw" DESC);--> statement-breakpoint

-- Seed: 7 canonical action types
INSERT INTO "loyalty_action_types" ("id", "display_name", "default_base", "is_active", "created_at_epoch") VALUES
  ('swap_same_chain',  'Swap (same-chain)',  100, true, EXTRACT(EPOCH FROM NOW())::int),
  ('swap_cross_chain', 'Swap (cross-chain)', 200, true, EXTRACT(EPOCH FROM NOW())::int),
  ('send_erc20',       'Send',               50,  true, EXTRACT(EPOCH FROM NOW())::int),
  ('yield_deposit',    'Yield deposit',      300, true, EXTRACT(EPOCH FROM NOW())::int),
  ('yield_hold_day',   'Yield hold (daily)', 10,  true, EXTRACT(EPOCH FROM NOW())::int),
  ('referral',         'Referral',           500, true, EXTRACT(EPOCH FROM NOW())::int),
  ('manual_adjust',    'Manual adjustment',  0,   true, EXTRACT(EPOCH FROM NOW())::int)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- Seed: Season 0 (closed alpha, 3.0x global multiplier)
INSERT INTO "loyalty_seasons" ("id", "name", "starts_at_epoch", "ends_at_epoch", "status", "formula_version", "config_json", "created_at_epoch", "updated_at_epoch") VALUES
  ('season-0', 'Season 0', EXTRACT(EPOCH FROM NOW())::int, 2147483647, 'active', 'v1',
   '{"globalMultiplier":3.0,"perActionCap":50000,"dailyUserCap":null,"actionBase":{"swap_same_chain":100,"swap_cross_chain":200,"send_erc20":50,"yield_deposit":300,"yield_hold_day":10,"referral":500,"manual_adjust":0},"actionMultiplier":{"swap_same_chain":1,"swap_cross_chain":1.5,"send_erc20":1,"yield_deposit":2,"yield_hold_day":1,"referral":1,"manual_adjust":1},"actionMinUsd":{"swap_same_chain":1,"swap_cross_chain":1},"volume":{"formula":"sqrt","divisor":100}}'::jsonb,
   EXTRACT(EPOCH FROM NOW())::int, EXTRACT(EPOCH FROM NOW())::int)
ON CONFLICT ("id") DO NOTHING;