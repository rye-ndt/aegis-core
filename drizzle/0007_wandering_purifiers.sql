CREATE TABLE IF NOT EXISTS "evaluation_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"system_prompt_hash" text NOT NULL,
	"memories_injected" text DEFAULT '[]' NOT NULL,
	"tool_calls" text DEFAULT '[]' NOT NULL,
	"reasoning_trace" text,
	"response" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"implicit_signal" text,
	"explicit_rating" integer,
	"outcome_confirmed" boolean,
	"created_at_epoch" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"fire_at_epoch" integer NOT NULL,
	"status" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "intent" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "flagged_for_compression" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "compressed_at_epoch" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scheduled_notifications_status_fire" ON "scheduled_notifications" USING btree ("status","fire_at_epoch");