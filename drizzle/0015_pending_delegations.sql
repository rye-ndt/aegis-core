CREATE TABLE "pending_delegations" (
  "id"               uuid PRIMARY KEY,
  "user_id"          uuid NOT NULL,
  "zerodev_message"  jsonb NOT NULL,
  "status"           text NOT NULL,
  "created_at_epoch" integer NOT NULL,
  "expires_at_epoch" integer NOT NULL
);
