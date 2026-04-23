ALTER TABLE "conversations" DROP COLUMN "summary";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "intent";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "flagged_for_compression";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "compressed_at_epoch";