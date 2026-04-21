CREATE TABLE "http_query_tool_headers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tool_id" uuid NOT NULL,
	"header_key" text NOT NULL,
	"header_value" text NOT NULL,
	"is_encrypted" boolean DEFAULT false NOT NULL,
	"created_at_epoch" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "http_query_tools" (
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
