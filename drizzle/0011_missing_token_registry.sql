CREATE TABLE "token_registry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"decimals" integer NOT NULL,
	"is_native" boolean NOT NULL DEFAULT false,
	"is_verified" boolean NOT NULL DEFAULT false,
	"logo_uri" text,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL,
	CONSTRAINT "token_registry_symbol_chain_id_key" UNIQUE("symbol","chain_id")
);
