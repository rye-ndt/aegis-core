/**
 * Phase 4 (Part 5) shadow-diff for findings. Joins LLM findings from
 * `prediction_market_findings` against deterministic rows in
 * `prediction_market_findings_shadow` over the last 7 days on
 * `runId + sorted(marketsInvolved) + patternType`. Reports:
 *   - LLM-only (deterministic missed it — false-negative risk).
 *   - Shadow-only (deterministic found something LLM missed — likely TP).
 *   - Both present where magnitudes diverge by ≥100 bps.
 *
 * Per-subject agreement % is the gating input to Part 7's promotion checklist.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/diff-findings-vs-shadow.ts
 */
import "dotenv/config";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { gte, inArray } from "drizzle-orm";
import pg from "pg";
import {
  predictionMarketFacts,
  predictionMarketFindings,
  predictionMarketFindingsShadow,
} from "../src/adapters/implementations/output/sqlDB/schema";
import { createLogger } from "../src/helpers/observability/logger";
import { newCurrentUTCEpoch } from "../src/helpers/time/dateTime";
import { inferSubject } from "../src/use-cases/interface/predictionMarket/marketFactFormat";
import { csvEscape } from "./_lib/csv";

const log = createLogger("diffFindingsVsShadow");

const OUTPUT_PATH = path.resolve(__dirname, "../tmp/phase4-findings-vs-shadow.csv");
const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;
const MAGNITUDE_DIVERGENCE_BPS = 100;

function joinKey(runId: string, ids: string[], pattern: string): string {
  return `${runId}::${pattern}::${[...ids].sort().join("|")}`;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  const cutoff = newCurrentUTCEpoch() - SEVEN_DAYS_SEC;
  const [llm, shadow] = await Promise.all([
    db
      .select({
        runId: predictionMarketFindings.runId,
        patternType: predictionMarketFindings.patternType,
        marketsInvolved: predictionMarketFindings.marketsInvolved,
        magnitudeBps: predictionMarketFindings.magnitudeBps,
      })
      .from(predictionMarketFindings)
      .where(gte(predictionMarketFindings.createdAtEpoch, cutoff)),
    db
      .select({
        runId: predictionMarketFindingsShadow.runId,
        patternType: predictionMarketFindingsShadow.patternType,
        marketsInvolved: predictionMarketFindingsShadow.marketsInvolved,
        magnitudeBps: predictionMarketFindingsShadow.magnitudeBps,
      })
      .from(predictionMarketFindingsShadow)
      .where(gte(predictionMarketFindingsShadow.createdAtEpoch, cutoff)),
  ]);

  const allMarketIds = Array.from(
    new Set([...llm, ...shadow].flatMap((r) => (r.marketsInvolved as string[]) ?? [])),
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

  const llmByKey = new Map<string, typeof llm[number]>();
  for (const r of llm) llmByKey.set(joinKey(r.runId, r.marketsInvolved as string[], r.patternType), r);
  const shadowByKey = new Map<string, typeof shadow[number]>();
  for (const r of shadow) shadowByKey.set(joinKey(r.runId, r.marketsInvolved as string[], r.patternType), r);

  interface Row {
    runId: string;
    bucket: "llm_only" | "shadow_only" | "both_agree" | "both_magnitude_diverge";
    subject: string;
    patternType: string;
    llmMagnitudeBps: number | null;
    shadowMagnitudeBps: number | null;
  }
  const rows: Row[] = [];
  const stats = new Map<string, { agree: number; llmOnly: number; shadowOnly: number }>();
  const bumpStat = (subj: string, key: keyof { agree: 0; llmOnly: 0; shadowOnly: 0 }): void => {
    const s = stats.get(subj) ?? { agree: 0, llmOnly: 0, shadowOnly: 0 };
    s[key] += 1;
    stats.set(subj, s);
  };

  for (const [k, r] of llmByKey) {
    const ids = r.marketsInvolved as string[];
    const subject = inferSubject(ids, subjectByMarket);
    const s = shadowByKey.get(k);
    if (!s) {
      rows.push({ runId: r.runId, bucket: "llm_only", subject, patternType: r.patternType, llmMagnitudeBps: r.magnitudeBps, shadowMagnitudeBps: null });
      bumpStat(subject, "llmOnly");
    } else {
      const diverge = Math.abs(r.magnitudeBps - s.magnitudeBps) >= MAGNITUDE_DIVERGENCE_BPS;
      rows.push({
        runId: r.runId,
        bucket: diverge ? "both_magnitude_diverge" : "both_agree",
        subject,
        patternType: r.patternType,
        llmMagnitudeBps: r.magnitudeBps,
        shadowMagnitudeBps: s.magnitudeBps,
      });
      bumpStat(subject, "agree");
    }
  }
  for (const [k, r] of shadowByKey) {
    if (llmByKey.has(k)) continue;
    const ids = r.marketsInvolved as string[];
    const subject = inferSubject(ids, subjectByMarket);
    rows.push({ runId: r.runId, bucket: "shadow_only", subject, patternType: r.patternType, llmMagnitudeBps: null, shadowMagnitudeBps: r.magnitudeBps });
    bumpStat(subject, "shadowOnly");
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  const header = "run_id,bucket,subject,pattern_type,llm_magnitude_bps,shadow_magnitude_bps\n";
  const body = rows
    .map((r) => [
      csvEscape(r.runId),
      csvEscape(r.bucket),
      csvEscape(r.subject),
      csvEscape(r.patternType),
      csvEscape(r.llmMagnitudeBps),
      csvEscape(r.shadowMagnitudeBps),
    ].join(","))
    .join("\n");
  await writeFile(OUTPUT_PATH, header + body + (body ? "\n" : ""));
  log.info({ path: OUTPUT_PATH, rows: rows.length }, "csv-written");

  for (const [subject, s] of stats) {
    const total = s.agree + s.llmOnly;
    const pct = total === 0 ? 0 : Math.round((s.agree / total) * 1000) / 10;
    log.info(
      { subject, agree: s.agree, llmOnly: s.llmOnly, shadowOnly: s.shadowOnly, agreePct: pct },
      "subject-agreement",
    );
  }

  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exitCode = 1;
});
