/**
 * Confirms the seed `SUBJECTS` list (`marketFactVocabularies.ts`) covers ≥85%
 * of the current top-N market universe. Per Part 2 of the deterministic-
 * detection plan: if coverage is <85%, expand the seed list before merging
 * Part 3 (the extractor depends on this vocabulary).
 *
 * Classification is a fast heuristic over `question` + `slug` + `category`.
 * It is **not** the production extractor — that lives in Part 3 and is
 * LLM-driven. This script's only job is to estimate coverage, so false
 * positives that map a market to the wrong subject are acceptable as long
 * as something other than `OTHER` matches.
 *
 * Exits non-zero when coverage of named subjects (everything except `OTHER`)
 * is below 85% so CI / pre-merge can gate on it.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/measure-subject-distribution.ts
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, desc, eq } from "drizzle-orm";
import pg from "pg";
import {
  predictionMarketRuns,
  predictionMarketSnapshots,
} from "../src/adapters/implementations/output/sqlDB/schema";
import { createLogger } from "../src/helpers/observability/logger";
import {
  SUBJECTS,
  type SubjectCode,
} from "../src/use-cases/interface/predictionMarket/marketFactVocabularies";

const log = createLogger("measureSubjectDistribution");

const COVERAGE_FLOOR = 0.85;

interface Classifier {
  subject: Exclude<SubjectCode, "OTHER">;
  match: (text: string) => boolean;
}

// Heuristic patterns — coverage estimator only, not the production extractor.
const CLASSIFIERS: Classifier[] = [
  {
    subject: "BTC_USD_SPOT",
    match: (t) => /\bbtc|bitcoin\b/.test(t) && /\$|usd|price|reach|hit/.test(t),
  },
  {
    subject: "ETH_USD_SPOT",
    match: (t) => /\beth|ethereum\b/.test(t) && /\$|usd|price|reach|hit/.test(t),
  },
  {
    subject: "SOL_USD_SPOT",
    match: (t) => /\bsol|solana\b/.test(t) && /\$|usd|price|reach|hit/.test(t),
  },
  {
    subject: "FED_FUNDS_RATE",
    match: (t) => /fed|fomc|interest.rate|rate.cut|rate.hike|federal.reserve/.test(t),
  },
  {
    subject: "CPI_YOY",
    match: (t) => /\bcpi\b|inflation|consumer.price/.test(t),
  },
  {
    subject: "US_PRES_2028",
    match: (t) => /(2028).*president|president.*2028|presidential.*2028/.test(t),
  },
  {
    subject: "US_HOUSE_2026",
    match: (t) => /(2026).*house|house.*2026|midterm.*house/.test(t),
  },
  {
    subject: "US_SENATE_2026",
    match: (t) => /(2026).*senate|senate.*2026|midterm.*senate/.test(t),
  },
  {
    subject: "NFL_SUPER_BOWL_LX_WINNER",
    match: (t) => /super.bowl|nfl.champion|superbowl/.test(t),
  },
  {
    subject: "NBA_FINALS_2026_WINNER",
    match: (t) => /nba.finals|nba.champion/.test(t),
  },
  {
    subject: "EPL_TITLE_2025_26",
    match: (t) => /\bepl\b|premier.league/.test(t),
  },
  {
    subject: "OSCARS_2026_BEST_PICTURE",
    match: (t) => /\boscar|academy.award|best.picture/.test(t),
  },
  {
    subject: "WEATHER_NYC_TEMP",
    match: (t) => /(nyc|new.york).*(temp|temperature|weather|snow|rain)/.test(t),
  },
  {
    subject: "BTC_DOMINANCE",
    match: (t) => /btc.dominance|bitcoin.dominance/.test(t),
  },
  {
    subject: "ETH_USD_PCT_VS_BTC",
    match: (t) => /eth.*vs.*btc|ethbtc|eth\/btc/.test(t),
  },
  {
    subject: "RECESSION_CALL_2026",
    match: (t) => /recession/.test(t) && /2026/.test(t),
  },
  {
    subject: "SP500_LEVEL",
    match: (t) => /s&p.*500|sp500|s.and.p.*500/.test(t),
  },
  {
    subject: "NASDAQ_LEVEL",
    match: (t) => /nasdaq/.test(t),
  },
  {
    subject: "UEFA_CHAMPIONS_LEAGUE_2025_26",
    match: (t) => /champions.league|uefa/.test(t),
  },
];

function classify(question: string, slug: string, category: string | null): SubjectCode {
  const haystack = `${question} ${slug} ${category ?? ""}`.toLowerCase();
  for (const c of CLASSIFIERS) {
    if (c.match(haystack)) return c.subject;
  }
  return "OTHER";
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  const latest = await db
    .select({ runId: predictionMarketRuns.runId })
    .from(predictionMarketRuns)
    .where(eq(predictionMarketRuns.isLatest, true))
    .orderBy(desc(predictionMarketRuns.createdAtEpoch))
    .limit(1);
  if (latest.length === 0) {
    throw new Error("no latest prediction-market run found");
  }
  const runId = latest[0]!.runId;

  const snapshots = await db
    .select({
      marketId: predictionMarketSnapshots.marketId,
      question: predictionMarketSnapshots.question,
      slug: predictionMarketSnapshots.slug,
      category: predictionMarketSnapshots.category,
    })
    .from(predictionMarketSnapshots)
    .where(and(eq(predictionMarketSnapshots.runId, runId)));

  log.info({ runId, total: snapshots.length }, "snapshots-loaded");

  const counts: Record<SubjectCode, number> = Object.fromEntries(
    SUBJECTS.map((s) => [s, 0]),
  ) as Record<SubjectCode, number>;
  const otherSamples: string[] = [];

  for (const s of snapshots) {
    const subject = classify(s.question, s.slug, s.category);
    counts[subject] += 1;
    if (subject === "OTHER" && otherSamples.length < 20) {
      otherSamples.push(`${s.marketId.slice(0, 8)} ${s.question.slice(0, 80)}`);
    }
  }

  const total = snapshots.length;
  const other = counts.OTHER;
  const matched = total - other;
  const coverage = total === 0 ? 0 : matched / total;

  log.info(
    { runId, total, matched, other, coveragePct: Math.round(coverage * 1000) / 10, floorPct: COVERAGE_FLOOR * 100 },
    "coverage-summary",
  );
  for (const subject of SUBJECTS) {
    if (counts[subject] > 0) {
      log.info({ subject, count: counts[subject] }, "subject-count");
    }
  }
  if (otherSamples.length > 0) {
    log.warn({ samples: otherSamples }, "OTHER bucket samples (expand SUBJECTS if these recur)");
  }

  await pool.end();

  if (coverage < COVERAGE_FLOOR) {
    log.error(
      { coveragePct: Math.round(coverage * 1000) / 10, floorPct: COVERAGE_FLOOR * 100 },
      "coverage-below-floor",
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exitCode = 1;
});
