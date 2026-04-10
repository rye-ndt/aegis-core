ALTER TABLE "users"
  ALTER COLUMN "hashed_password" DROP NOT NULL,
  ADD COLUMN "privy_did" text UNIQUE;
