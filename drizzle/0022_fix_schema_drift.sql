-- Custom SQL migration file, put your code below! --
-- Corrective migration: backfills tables/columns dropped by prior merge conflicts.
-- All statements are idempotent so re-running is safe and partially-patched
-- environments converge to the schema.ts definition.

ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "smart_account_address" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "eoa_address" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "session_key_address" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "session_key_scope" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "session_key_status" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "session_key_expires_at_epoch" integer;--> statement-breakpoint

ALTER TABLE "tool_manifests" ADD COLUMN IF NOT EXISTS "required_fields" text;--> statement-breakpoint
ALTER TABLE "tool_manifests" ADD COLUMN IF NOT EXISTS "final_schema" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "intents" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "raw_input" text NOT NULL,
  "parsed_json" text NOT NULL,
  "status" text NOT NULL,
  "rejection_reason" text,
  "created_at_epoch" integer NOT NULL,
  "updated_at_epoch" integer NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "intent_executions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "intent_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "smart_account_address" text NOT NULL,
  "solver_used" text NOT NULL,
  "simulation_passed" boolean NOT NULL,
  "simulation_result" text,
  "user_op_hash" text,
  "tx_hash" text,
  "status" text NOT NULL,
  "error_message" text,
  "gas_used" text,
  "fee_amount" text,
  "fee_token" text,
  "created_at_epoch" integer NOT NULL,
  "updated_at_epoch" integer NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pending_delegations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL,
  "zerodev_message" jsonb NOT NULL,
  "status" text NOT NULL,
  "created_at_epoch" integer NOT NULL,
  "expires_at_epoch" integer NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fee_records" (
  "id" uuid PRIMARY KEY NOT NULL,
  "execution_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "total_fee_bps" integer NOT NULL,
  "platform_fee_bps" integer NOT NULL,
  "contributor_fee_bps" integer NOT NULL,
  "fee_token_address" text NOT NULL,
  "fee_amount_raw" text NOT NULL,
  "platform_address" text NOT NULL,
  "contributor_address" text,
  "tx_hash" text NOT NULL,
  "chain_id" integer NOT NULL,
  "created_at_epoch" integer NOT NULL
);
