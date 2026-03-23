CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jarvis_config" (
	"id" text PRIMARY KEY NOT NULL,
	"system_prompt" text NOT NULL,
	"updated_at_epoch" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_name" text,
	"tool_call_id" text,
	"created_at_epoch" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"user_name" text NOT NULL,
	"hashed_password" text NOT NULL,
	"email" text NOT NULL,
	"dob" integer NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"personalities" text[] DEFAULT '{}' NOT NULL,
	"secondary_personalities" text[] DEFAULT '{}' NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL
);
