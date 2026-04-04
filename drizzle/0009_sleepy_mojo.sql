ALTER TABLE "allowed_telegram_ids" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "allowed_telegram_ids" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "full_name";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "dob";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");