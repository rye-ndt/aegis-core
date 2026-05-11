/**
 * Hourly hygiene cron (Part 7). Reports the depth of the
 * `prediction_market_extraction_reviews` pending queue. When depth exceeds
 * `THRESHOLD`, posts a single Telegram alert to the admin chat.
 *
 * Usage (cron-friendly):
 *   DATABASE_URL=... TELEGRAM_BOT_TOKEN=... \
 *     PREDICTION_MARKETS_REVIEW_ADMIN_CHAT_ID=... \
 *     npx tsx scripts/check-extraction-review-queue.ts
 *
 * Exits 0 always so failure to alert never wedges the cron.
 */
import "dotenv/config";
import { Api } from "grammy";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import pg from "pg";
import { predictionMarketExtractionReviews } from "../src/adapters/implementations/output/sqlDB/schema";
import { createLogger } from "../src/helpers/observability/logger";

const log = createLogger("checkExtractionReviewQueue");

const THRESHOLD = Number(process.env.PREDICTION_MARKETS_REVIEW_QUEUE_ALERT_THRESHOLD ?? 10);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  const pending = await db
    .select({ id: predictionMarketExtractionReviews.reviewId })
    .from(predictionMarketExtractionReviews)
    .where(eq(predictionMarketExtractionReviews.status, "pending"));
  const depth = pending.length;

  log.info({ depth, threshold: THRESHOLD }, "review-queue-depth");

  if (depth >= THRESHOLD) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.PREDICTION_MARKETS_REVIEW_ADMIN_CHAT_ID;
    if (token && chatId) {
      try {
        await new Api(token).sendMessage(
          chatId,
          `🟡 Prediction-market extraction review queue: ${depth} pending (threshold ${THRESHOLD}).`,
        );
        log.info({ chatId, depth }, "alert-sent");
      } catch (err) {
        log.error({ err }, "alert-send-failed");
      }
    } else {
      log.warn({ depth }, "alert-skipped — missing TELEGRAM_BOT_TOKEN or PREDICTION_MARKETS_REVIEW_ADMIN_CHAT_ID");
    }
  }

  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "fatal");
});
