ALTER TABLE "prediction_market_findings" ADD COLUMN "sized_trades" jsonb;--> statement-breakpoint
ALTER TABLE "prediction_market_findings" ADD COLUMN "expected_profit_usdc_cents" integer;--> statement-breakpoint
ALTER TABLE "prediction_market_findings" ADD COLUMN "min_payoff_usdc_cents" integer;