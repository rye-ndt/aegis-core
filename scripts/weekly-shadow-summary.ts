/**
 * Weekly hygiene cron (Part 7). Reads the Part 5 shadow-agreement metric for
 * the last 7 days, compares against the prior 7 days, and posts a one-line
 * summary per subject to the admin chat: `subject X: agreement 96.3% (Δ −0.4pp)`.
 *
 * Usage:
 *   DATABASE_URL=... TELEGRAM_BOT_TOKEN=... \
 *     PREDICTION_MARKETS_REVIEW_ADMIN_CHAT_ID=... \
 *     npx tsx scripts/weekly-shadow-summary.ts
 */
import "dotenv/config";
import { Api } from "grammy";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { DrizzlePredictionMarketRepo } from "../src/adapters/implementations/output/sqlDB/repositories/predictionMarket.repo";
import { createLogger } from "../src/helpers/observability/logger";

const log = createLogger("weeklyShadowSummary");

const WEEK_SEC = 7 * 24 * 60 * 60;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);
  const repo = new DrizzlePredictionMarketRepo(db);

  // Δ is week-over-week (current 7d vs prior 7d). The repo only exposes
  // trailing windows, so the prior-week counts are the trailing-14d minus
  // the trailing-7d counts per subject.
  const [current, trailing14d] = await Promise.all([
    repo.getShadowAgreement(WEEK_SEC),
    repo.getShadowAgreement(2 * WEEK_SEC),
  ]);
  const trailing14dBySubject = new Map(
    trailing14d.perSubject.map((r) => [r.subject, r] as const),
  );

  const lines: string[] = [`📊 Shadow-agreement (last 7d, overall ${current.overall.agreementPct}%):`];
  for (const row of current.perSubject) {
    const t14 = trailing14dBySubject.get(row.subject);
    const priorAgreed = (t14?.agreed ?? row.agreed) - row.agreed;
    const priorLlmOnly = (t14?.llmOnly ?? row.llmOnly) - row.llmOnly;
    const priorTotal = priorAgreed + priorLlmOnly;
    const priorPct = priorTotal === 0 ? row.agreementPct : Math.round((priorAgreed / priorTotal) * 1000) / 10;
    const delta = Math.round((row.agreementPct - priorPct) * 10) / 10;
    const sign = delta >= 0 ? "+" : "";
    lines.push(`  ${row.subject}: ${row.agreementPct}% (Δ ${sign}${delta}pp wow, n=${row.agreed + row.llmOnly})`);
  }
  const text = lines.join("\n");
  log.info({ subjects: current.perSubject.length }, "summary-built");

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.PREDICTION_MARKETS_REVIEW_ADMIN_CHAT_ID;
  if (token && chatId) {
    try {
      await new Api(token).sendMessage(chatId, text);
      log.info({ chatId }, "summary-sent");
    } catch (err) {
      log.error({ err }, "summary-send-failed");
    }
  } else {
    log.warn("alert-skipped — missing TELEGRAM_BOT_TOKEN or PREDICTION_MARKETS_REVIEW_ADMIN_CHAT_ID");
    console.log(text); // eslint-disable-line no-console
  }

  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "fatal");
});
