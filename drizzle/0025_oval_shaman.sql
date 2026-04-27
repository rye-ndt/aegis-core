CREATE TABLE "recipient_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipient_telegram_user_id" text NOT NULL,
	"recipient_user_id" uuid,
	"recipient_chat_id" text,
	"sender_user_id" uuid NOT NULL,
	"sender_chat_id" text NOT NULL,
	"sender_display_name" text,
	"sender_handle" text,
	"kind" text NOT NULL,
	"token_symbol" text NOT NULL,
	"amount_formatted" text NOT NULL,
	"chain_id" integer NOT NULL,
	"tx_hash" text,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at_epoch" integer NOT NULL,
	"delivered_at_epoch" integer
);
--> statement-breakpoint
CREATE INDEX "recipient_notif_by_tg_user_idx" ON "recipient_notifications" USING btree ("recipient_telegram_user_id","status");--> statement-breakpoint
CREATE INDEX "recipient_notif_created_at_idx" ON "recipient_notifications" USING btree ("created_at_epoch");