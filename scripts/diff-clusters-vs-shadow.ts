/**
 * Phase 3 (Part 4) shadow-diff. Joins LLM-emitted clusters from
 * `prediction_market_clusters` against deterministic clusters in
 * `prediction_market_clusters_shadow` on `runId`. Reports:
 *   - LLM clusters with no shadow equivalent (coverage gap).
 *   - Shadow clusters with no LLM equivalent (deterministic-only finds).
 *   - Same-runId same-`marketIds-set` clusters with diverging `kind` /
 *     `expectedRelationships`.
 *
 * Per-subject agreement % feeds Part 7's promotion checklist.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/diff-clusters-vs-shadow.ts
 */
import "dotenv/config";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { gte, inArray } from "drizzle-orm";
import pg from "pg";
import {
  predictionMarketClusters,
  predictionMarketClustersShadow,
  predictionMarketFacts,
  predictionMarketRuns,
} from "../src/adapters/implementations/output/sqlDB/schema";
import { createLogger } from "../src/helpers/observability/logger";
import { newCurrentUTCEpoch } from "../src/helpers/time/dateTime";
import { inferSubject } from "../src/use-cases/interface/predictionMarket/marketFactFormat";
import { csvEscape } from "./_lib/csv";

const log = createLogger("diffClustersVsShadow");

const OUTPUT_PATH = path.resolve(__dirname, "../tmp/phase3-clusters-vs-shadow.csv");
const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

function marketSetKey(ids: string[]): string {
  return [...ids].sort().join("|");
}

function firstKind(expected: unknown): string {
  if (!Array.isArray(expected) || expected.length === 0) return "";
  const first = expected[0] as { kind?: unknown } | undefined;
  return typeof first?.kind === "string" ? first.kind : "";
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
    log.info({ cutoff }, "no recent runs");
    await pool.end();
    return;
  }
  const runIds = recentRuns.map((r) => r.runId);

  const [llmRows, shadowRows] = await Promise.all([
    db
      .select({
        runId: predictionMarketClusters.runId,
        clusterId: predictionMarketClusters.clusterId,
        marketIds: predictionMarketClusters.marketIds,
        expectedRelationships: predictionMarketClusters.expectedRelationships,
        derivedSubject: predictionMarketClusters.derivedSubject,
        theme: predictionMarketClusters.theme,
      })
      .from(predictionMarketClusters)
      .where(inArray(predictionMarketClusters.runId, runIds)),
    db
      .select({
        runId: predictionMarketClustersShadow.runId,
        shadowClusterId: predictionMarketClustersShadow.shadowClusterId,
        marketIds: predictionMarketClustersShadow.marketIds,
        expectedRelationships: predictionMarketClustersShadow.expectedRelationships,
        derivedSubject: predictionMarketClustersShadow.derivedSubject,
        theme: predictionMarketClustersShadow.theme,
      })
      .from(predictionMarketClustersShadow)
      .where(inArray(predictionMarketClustersShadow.runId, runIds)),
  ]);

  const allMarketIds = Array.from(
    new Set(
      [...llmRows, ...shadowRows].flatMap((r) => (r.marketIds as string[]) ?? []),
    ),
  );
  const factRows = allMarketIds.length === 0
    ? []
    : await db
        .select({
          marketId: predictionMarketFacts.marketId,
          subject: predictionMarketFacts.subject,
        })
        .from(predictionMarketFacts)
        .where(inArray(predictionMarketFacts.marketId, allMarketIds));
  const subjectByMarket = new Map(factRows.map((r) => [r.marketId, r.subject]));

  interface Row {
    runId: string;
    bucket: "llm_only" | "shadow_only" | "both_match" | "both_kind_diff";
    subject: string;
    llmKind: string;
    shadowKind: string;
    nMarkets: number;
  }
  const rows: Row[] = [];
  const subjectStats = new Map<string, { matches: number; total: number }>();

  const llmByRunKey = new Map<string, typeof llmRows[number]>();
  for (const r of llmRows) {
    llmByRunKey.set(`${r.runId}::${marketSetKey(r.marketIds as string[])}`, r);
  }
  const shadowByRunKey = new Map<string, typeof shadowRows[number]>();
  for (const r of shadowRows) {
    shadowByRunKey.set(`${r.runId}::${marketSetKey(r.marketIds as string[])}`, r);
  }

  for (const r of llmRows) {
    const ids = r.marketIds as string[];
    const key = `${r.runId}::${marketSetKey(ids)}`;
    const sShadow = shadowByRunKey.get(key);
    const subject = inferSubject(ids, subjectByMarket);
    const llmKind = firstKind(r.expectedRelationships);
    if (!sShadow) {
      rows.push({ runId: r.runId, bucket: "llm_only", subject, llmKind, shadowKind: "", nMarkets: ids.length });
    } else {
      const sKind = firstKind(sShadow.expectedRelationships);
      const bucket: Row["bucket"] = sKind === llmKind ? "both_match" : "both_kind_diff";
      rows.push({ runId: r.runId, bucket, subject, llmKind, shadowKind: sKind, nMarkets: ids.length });
    }
    const bucket = subjectStats.get(subject) ?? { matches: 0, total: 0 };
    bucket.total += 1;
    if (sShadow) bucket.matches += 1;
    subjectStats.set(subject, bucket);
  }

  for (const r of shadowRows) {
    const ids = r.marketIds as string[];
    const key = `${r.runId}::${marketSetKey(ids)}`;
    if (llmByRunKey.has(key)) continue;
    const subject = inferSubject(ids, subjectByMarket);
    const shadowKind = firstKind(r.expectedRelationships);
    rows.push({ runId: r.runId, bucket: "shadow_only", subject, llmKind: "", shadowKind, nMarkets: ids.length });
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  const header = "run_id,bucket,subject,llm_kind,shadow_kind,n_markets\n";
  const body = rows
    .map((r) => [
      csvEscape(r.runId),
      csvEscape(r.bucket),
      csvEscape(r.subject),
      csvEscape(r.llmKind),
      csvEscape(r.shadowKind),
      csvEscape(r.nMarkets),
    ].join(","))
    .join("\n");
  await writeFile(OUTPUT_PATH, header + body + (body ? "\n" : ""));
  log.info({ path: OUTPUT_PATH, rows: rows.length }, "csv-written");

  for (const [subject, b] of subjectStats) {
    const pct = b.total === 0 ? 0 : Math.round((b.matches / b.total) * 1000) / 10;
    log.info({ subject, matches: b.matches, total: b.total, agreePct: pct }, "subject-agreement");
  }

  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exitCode = 1;
});
