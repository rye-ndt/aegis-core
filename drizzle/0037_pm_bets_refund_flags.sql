ALTER TABLE "prediction_market_bets" ADD COLUMN "refund_required" boolean NOT NULL DEFAULT false;
ALTER TABLE "prediction_market_bets" ADD COLUMN "refund_tx_hash" text;
