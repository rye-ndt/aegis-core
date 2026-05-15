/**
 * Inject a synthetic prediction-market finding (tagged `[TEST_FINDING]`) and
 * send a Telegram card with the same `place_bet:<findingId>:A|B` callback
 * buttons the real broadcaster emits. Lets you exercise the bet-flow UI
 * without paying for an LLM scan tick.
 *
 * Inject + send:
 *   DATABASE_URL=... TELEGRAM_BOT_TOKEN=... \
 *     npx tsx scripts/test-prediction-finding.ts --chat-id 123456789
 *
 * Cleanup (removes every row with rationale prefixed `[TEST_FINDING]`):
 *   DATABASE_URL=... npx tsx scripts/test-prediction-finding.ts --cleanup
 *
 * Removable in one step: `rm scripts/test-prediction-finding.ts` after running
 * `--cleanup`. Touches no production source files.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { desc, eq, like } from "drizzle-orm";
import pg from "pg";
import {
  predictionMarketClusters,
  predictionMarketFindings,
  predictionMarketRuns,
  predictionMarketSnapshots,
} from "../src/adapters/implementations/output/sqlDB/schema";
import { newCurrentUTCEpoch } from "../src/helpers/time/dateTime";
import { newUuid } from "../src/helpers/uuid";
import { createLogger } from "../src/helpers/observability/logger";

const log = createLogger("testPredictionFinding");
const TAG = "[TEST_FINDING]";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function cleanup(db: ReturnType<typeof drizzle>): Promise<void> {
  // Findings reference clusters via clusterId — delete findings first.
  const findings = await db
    .delete(predictionMarketFindings)
    .where(like(predictionMarketFindings.rationale, `${TAG}%`))
    .returning({ id: predictionMarketFindings.findingId });
  const clusters = await db
    .delete(predictionMarketClusters)
    .where(like(predictionMarketClusters.rationale, `${TAG}%`))
    .returning({ id: predictionMarketClusters.clusterId });
  log.info({ findings: findings.length, clusters: clusters.length }, "cleanup complete");
}

async function inject(db: ReturnType<typeof drizzle>, chatId: number, botToken: string): Promise<void> {
  const latestRun = await db
    .select({ runId: predictionMarketRuns.runId })
    .from(predictionMarketRuns)
    .orderBy(desc(predictionMarketRuns.createdAtEpoch))
    .limit(1);
  if (latestRun.length === 0) {
    throw new Error("no prediction_market_runs rows — run at least one scan first");
  }
  const runId = latestRun[0]!.runId;

  const snaps = await db
    .select({
      marketId: predictionMarketSnapshots.marketId,
      slug: predictionMarketSnapshots.slug,
      question: predictionMarketSnapshots.question,
      yesPriceBp: predictionMarketSnapshots.yesPriceBp,
    })
    .from(predictionMarketSnapshots)
    .where(eq(predictionMarketSnapshots.runId, runId))
    .limit(2);
  if (snaps.length < 2) {
    throw new Error(`run ${runId} has <2 snapshots; cannot synthesise a 2-side finding`);
  }
  const [a, b] = snaps as [typeof snaps[0], typeof snaps[0]];

  const clusterId = newUuid();
  const findingId = newUuid();
  const now = newCurrentUTCEpoch();
  const yesA = a.yesPriceBp / 10000;
  const yesB = b.yesPriceBp / 10000;

  await db.insert(predictionMarketClusters).values({
    clusterId,
    runId,
    theme: `${TAG} synthetic test cluster`,
    causalDriver: "test-only",
    marketIds: [a.marketId, b.marketId],
    expectedRelationships: [
      { kind: "mutually_exclusive", description: "synthetic test relationship" },
    ],
    rationale: `${TAG} injected by test-prediction-finding.ts`,
    confidence: "high",
    derivedSubject: null,
  });

  await db.insert(predictionMarketFindings).values({
    findingId,
    runId,
    clusterId,
    patternType: "logical_inconsistency",
    marketsInvolved: [a.marketId, b.marketId],
    currentState: { citedOdds: { [a.marketId]: yesA, [b.marketId]: yesB } },
    liveOdds: { [a.marketId]: yesA, [b.marketId]: yesB },
    whyAnomalous: "Synthetic finding — test the bet-flow UI without an LLM scan.",
    sideA: {
      label: `YES ${a.slug.slice(0, 40)}`,
      marketId: a.marketId,
      outcome: "YES",
      rationale: "Test side A.",
    },
    sideB: {
      label: `NO ${b.slug.slice(0, 40)}`,
      marketId: b.marketId,
      outcome: "NO",
      rationale: "Test side B.",
    },
    confidence: "high",
    magnitudeBps: 500,
    rankScore: 1000,
    rationale: `${TAG} injected by test-prediction-finding.ts`,
    createdAtEpoch: now,
    broadcastedAtEpoch: null,
    editorialOutcome: null,
    sizedTrades: null,
    expectedProfitUsdcCents: null,
    minPayoffUsdcCents: null,
  });

  log.info({ findingId, clusterId, runId }, "synthetic finding inserted");

  // Send a minimal card carrying the same callback payloads the real
  // broadcaster emits, so the bet capability resolves the finding by id.
  const text =
    `TEST FINDING (synthetic)\n\n` +
    `Pattern: logical_inconsistency\n` +
    `Markets:\n` +
    `- ${a.question} — YES ${(yesA * 100).toFixed(1)}%\n` +
    `- ${b.question} — YES ${(yesB * 100).toFixed(1)}%\n\n` +
    `Click a button to exercise the bet flow.`;
  const reply_markup = {
    inline_keyboard: [[
      { text: `Bet YES ${a.slug.slice(0, 30)}`, callback_data: `place_bet:${findingId}:A` },
      { text: `Bet NO ${b.slug.slice(0, 30)}`, callback_data: `place_bet:${findingId}:B` },
    ]],
  };
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup }),
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(`telegram sendMessage failed: ${resp.status} ${body}`);
  }
  log.info({ chatId, findingId, status: resp.status }, "telegram card sent");
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    if (process.argv.includes("--cleanup")) {
      await cleanup(db);
      return;
    }
    const chatIdRaw = arg("--chat-id") ?? process.env.TEST_CHAT_ID;
    if (!chatIdRaw) throw new Error("--chat-id <telegram_chat_id> (or TEST_CHAT_ID env) is required");
    const chatId = Number(chatIdRaw);
    if (!Number.isInteger(chatId)) throw new Error(`invalid chat id: ${chatIdRaw}`);
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
    await inject(db, chatId, botToken);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  log.error({ err }, "test-prediction-finding failed");
  process.exit(1);
});
