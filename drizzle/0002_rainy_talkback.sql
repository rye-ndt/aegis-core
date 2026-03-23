CREATE TABLE "google_oauth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at_epoch" integer NOT NULL,
	"scope" text NOT NULL,
	"updated_at_epoch" integer NOT NULL,
	CONSTRAINT "google_oauth_tokens_user_id_unique" UNIQUE("user_id")
);
