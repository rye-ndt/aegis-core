CREATE TABLE "todo_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"deadline_epoch" integer NOT NULL,
	"priority" text NOT NULL,
	"status" text NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL
);
