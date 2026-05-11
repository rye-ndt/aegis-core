/**
 * Phase 2 shadow comparison — for each LLM-clustered group in the last week,
 * resolve every member market to its `prediction_market_facts` row and
 * report whether deterministic clustering (same `eventFamily` across all
 * regex-verified members) would agree with the LLM grouping.
 *
 * Per-subject aggregate `agree` rate is the gating metric for promoting that
 * subject in Part 7 (≥95% threshold). This script gives a first read against
 * the seed extractor output.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/compare-extraction-vs-llm-clusters.ts
 */
import "dotenv/config";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { gte, inArray } from "drizzle-orm";
import pg from "pg";
import {
  predictionMarketClusters,
  predictionMarketFacts,
  predictionMarketRuns,
} from "../src/adapters/implementations/output/sqlDB/schema";
import { createLogger } from "../src/helpers/observability/logger";
import { newCurrentUTCEpoch } from "../src/helpers/time/dateTime";

const log = createLogger("compareExtractionVsLLMClusters");

const OUTPUT_PATH = path.resolve(__dirname, "../tmp/phase2-extraction-vs-llm.csv");
const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

function csvEscape(v: string | number | boolean | null): string {
  if (v === null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  const cutoff = newCurrentUTCEpoch() - SEVEN_DAYS_SEC;

  const recentRuns = await db
    .select({ runId: predictionMarketRuns.runId })
    .from(predictionMarketRuns)
    .where(gte(predictionMarketRuns.createdAtEpoch, cutoff));
  if (recentRuns.length === 0) {
    log.info({ cutoff }, "no recent runs — nothing to compare");
    await pool.end();
    return;
  }
  const runIds = recentRuns.map((r) => r.runId);

  const clusters = await db
    .select({
      clusterId: predictionMarketClusters.clusterId,
      theme: predictionMarketClusters.theme,
      marketIds: predictionMarketClusters.marketIds,
    })
    .from(predictionMarketClusters)
    .where(inArray(predictionMarketClusters.runId, runIds));

  const allMarketIds = Array.from(
    new Set(clusters.flatMap((c) => (c.marketIds as string[]) ?? [])),
  );
  const factRows = allMarketIds.length === 0
    ? []
    : await db
        .select({
          marketId: predictionMarketFacts.marketId,
          subject: predictionMarketFacts.subject,
          eventFamily: predictionMarketFacts.eventFamily,
          regexVerified: predictionMarketFacts.regexVerified,
        })
        .from(predictionMarketFacts)
        .where(inArray(predictionMarketFacts.marketId, allMarketIds));
  const factsByMarket = new Map(factRows.map((f) => [f.marketId, f]));

  interface Row {
    clusterId: string;
    theme: string;
    nMembers: number;
    nWithFact: number;
    distinctEventFamilies: number;
    agree: boolean;
    subject: string;
  }
  const rows: Row[] = [];
  const subjectAgreement = new Map<string, { agree: number; total: number }>();

  for (const c of clusters) {
    const memberIds = (c.marketIds as string[]) ?? [];
    let nWithFact = 0;
    let allVerified = memberIds.length > 0;
    const families = new Set<string>();
    const subjects = new Set<string>();
    for (const id of memberIds) {
      const f = factsByMarket.get(id);
      if (!f) {
        allVerified = false;
        continue;
      }
      nWithFact += 1;
      families.add(f.eventFamily);
      subjects.add(f.subject);
      if (!f.regexVerified) allVerified = false;
    }
    const agree = allVerified && families.size === 1;
    const subject = subjects.size === 1 ? Array.from(subjects)[0]! : "MIXED";

    rows.push({
      clusterId: c.clusterId,
      theme: c.theme,
      nMembers: memberIds.length,
      nWithFact,
      distinctEventFamilies: families.size,
      agree,
      subject,
    });

    if (subjects.size === 1) {
      const key = Array.from(subjects)[0]!;
      const bucket = subjectAgreement.get(key) ?? { agree: 0, total: 0 };
      bucket.total += 1;
      if (agree) bucket.agree += 1;
      subjectAgreement.set(key, bucket);
    }
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  const header =
    "cluster_id,theme,n_members,n_with_fact,distinct_event_families,agree,subject\n";
  const body = rows
    .map((r) =>
      [
        csvEscape(r.clusterId),
        csvEscape(r.theme),
        csvEscape(r.nMembers),
        csvEscape(r.nWithFact),
        csvEscape(r.distinctEventFamilies),
        csvEscape(r.agree),
        csvEscape(r.subject),
      ].join(","),
    )
    .join("\n");
  await writeFile(OUTPUT_PATH, header + body + (body ? "\n" : ""));
  log.info({ path: OUTPUT_PATH, rows: rows.length }, "csv-written");

  for (const [subject, b] of subjectAgreement) {
    const pct = b.total === 0 ? 0 : Math.round((b.agree / b.total) * 1000) / 10;
    log.info({ subject, agree: b.agree, total: b.total, agreePct: pct }, "subject-agreement");
  }

  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exitCode = 1;
});
