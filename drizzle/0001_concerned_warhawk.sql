CREATE TABLE "user_memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"enriched_content" text,
	"category" text,
	"pinecone_id" text NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL,
	"last_accessed_epoch" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jarvis_config" ADD COLUMN "max_tool_rounds" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tool_calls_json" text;