CREATE TABLE "allowed_telegram_ids" (
	"telegram_chat_id" text PRIMARY KEY NOT NULL,
	"added_at_epoch" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "telegram_chat_id" text;