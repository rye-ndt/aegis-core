CREATE TABLE "yield_deposits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"protocol_id" text NOT NULL,
	"token_address" text NOT NULL,
	"amount_raw" text NOT NULL,
	"requested_pct" integer NOT NULL,
	"idle_at_request_raw" text NOT NULL,
	"tx_hash" text,
	"user_op_hash" text,
	"status" text NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yield_position_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"protocol_id" text NOT NULL,
	"token_address" text NOT NULL,
	"snapshot_date_utc" text NOT NULL,
	"balance_raw" text NOT NULL,
	"principal_raw" text NOT NULL,
	"snapshot_at_epoch" integer NOT NULL,
	CONSTRAINT "yield_position_snapshots_user_id_chain_id_protocol_id_token_address_snapshot_date_utc_unique" UNIQUE("user_id","chain_id","protocol_id","token_address","snapshot_date_utc")
);
--> statement-breakpoint
CREATE TABLE "yield_withdrawals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"protocol_id" text NOT NULL,
	"token_address" text NOT NULL,
	"amount_raw" text NOT NULL,
	"tx_hash" text,
	"user_op_hash" text,
	"status" text NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "yield_deposits" ADD CONSTRAINT "yield_deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yield_position_snapshots" ADD CONSTRAINT "yield_position_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yield_withdrawals" ADD CONSTRAINT "yield_withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "yield_deposits_user_id_chain_id_protocol_id_index" ON "yield_deposits" USING btree ("user_id","chain_id","protocol_id");--> statement-breakpoint
CREATE INDEX "yield_withdrawals_user_id_chain_id_protocol_id_index" ON "yield_withdrawals" USING btree ("user_id","chain_id","protocol_id");