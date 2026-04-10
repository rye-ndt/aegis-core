CREATE TABLE "tool_manifests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tool_id" text NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"protocol_name" text NOT NULL,
	"tags" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"input_schema" text NOT NULL,
	"steps" text NOT NULL,
	"preflight_preview" text,
	"revenue_wallet" text,
	"is_verified" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"chain_ids" text NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL,
	CONSTRAINT "tool_manifests_tool_id_unique" UNIQUE("tool_id")
);
--> statement-breakpoint
ALTER TABLE "token_registry" DROP CONSTRAINT "token_registry_symbol_chain_id_key";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "personalities";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "secondary_personalities";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "display_name";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "personalities";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "wake_up_hour";--> statement-breakpoint
ALTER TABLE "token_registry" ADD CONSTRAINT "token_registry_symbol_chain_id_unique" UNIQUE("symbol","chain_id");