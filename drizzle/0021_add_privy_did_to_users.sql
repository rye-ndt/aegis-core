-- Custom SQL migration file, put your code below! --

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "privy_did" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_privy_did_unique" UNIQUE("privy_did");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "hashed_password" DROP NOT NULL;
