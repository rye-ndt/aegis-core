DROP TABLE IF EXISTS "tool_manifests";
--> statement-breakpoint
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
