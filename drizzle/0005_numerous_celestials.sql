CREATE TABLE "user_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text,
	"personalities" text[] DEFAULT '{}' NOT NULL,
	"wake_up_hour" integer,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL
);
