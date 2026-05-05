CREATE TABLE "stock_pairs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"chain_id" integer NOT NULL,
	"pair_base" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at_epoch" integer NOT NULL,
	"updated_at_epoch" integer NOT NULL,
	CONSTRAINT "stock_pairs_symbol_chain_id_unique" UNIQUE("symbol","chain_id")
);
