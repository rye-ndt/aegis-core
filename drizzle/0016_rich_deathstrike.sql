CREATE TABLE "command_tool_mappings" (
	"command" text PRIMARY KEY NOT NULL,
	"tool_id" text NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL
);