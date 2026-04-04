CREATE TABLE "telegram_sessions" (
	"telegram_chat_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at_epoch" integer NOT NULL,
	"created_at_epoch" integer NOT NULL
);
