CREATE TABLE IF NOT EXISTS "http_query_tool_headers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tool_id" uuid NOT NULL,
	"header_key" text NOT NULL,
	"header_value" text NOT NULL,
	"is_encrypted" boolean DEFAULT false NOT NULL,
	"created_at_epoch" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "http_query_tools" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"request_body_schema" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL,
	CONSTRAINT "http_query_tools_user_id_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_delegations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_address" text NOT NULL,
	"token_symbol" text NOT NULL,
	"token_decimals" integer NOT NULL,
	"limit_raw" text NOT NULL,
	"spent_raw" text DEFAULT '0' NOT NULL,
	"valid_until" integer NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL,
	CONSTRAINT "token_delegations_user_id_token_address_unique" UNIQUE("user_id","token_address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"aegis_guard_enabled" boolean DEFAULT false NOT NULL,
	"updated_at_epoch" integer NOT NULL,
	CONSTRAINT "user_preferences_user_id_unique" UNIQUE("user_id")
);
