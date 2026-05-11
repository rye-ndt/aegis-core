/**
 * Phase 0 replay — baseline FP-rate measurement for the role-tag + directional
 * verifier change in `2026-05-11-prediction-markets-deterministic-detection-part1.md`.
 *
 * Pre-Phase-0 findings have no role tags, so reconstruction is heuristic:
 * nested logical/implied-contradiction rows can't be recovered from prices
 * alone and are flagged `missing-role-tag`; term-structure rows derive
 * earlier/later deterministically from `resolution_epoch_sec`; mutually-
 * exclusive and movement_divergence keep their old magnitude.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/replay-verifier-on-recent-findings.ts
 */
import "dotenv/config";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { gte, inArray } from "drizzle-orm";
import pg from "pg";
import {
  predictionMarketClusters,
  predictionMarketFindings,
  predictionMarketSnapshots,
} from "../src/adapters/implementations/output/sqlDB/schema";
import {
  primaryKind,
  sumDeviationBps,
} from "../src/adapters/implementations/output/predictionMarket/predictionMarketVerifier";
import { createLogger } from "../src/helpers/observability/logger";
import { newCurrentUTCEpoch } from "../src/helpers/time/dateTime";
import type {
  ExpectedRelationship,
  ExpectedRelationshipKind,
  FindingCurrentState,
  FindingPatternType,
} from "../src/use-cases/interface/predictionMarket/PredictionMarketTypes";

const log = createLogger("replayVerifierOnRecentFindings");

const OUTPUT_PATH = path.resolve(__dirname, "../tmp/phase0-replay.csv");
const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

interface ReplayRow {
  findingId: string;
  patternType: FindingPatternType;
  clusterKind: ExpectedRelationshipKind | "unknown";
  oldMagnitudeBps: number;
  newMagnitudeBps: number | null;
  wouldDrop: boolean;
  dropReason: "" | "missing-role-tag" | "wrong-direction";
}

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
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  const cutoff = newCurrentUTCEpoch() - SEVEN_DAYS_SEC;

  const findings = await db
    .select({
      findingId: predictionMarketFindings.findingId,
      runId: predictionMarketFindings.runId,
      clusterId: predictionMarketFindings.clusterId,
      patternType: predictionMarketFindings.patternType,
      marketsInvolved: predictionMarketFindings.marketsInvolved,
      currentState: predictionMarketFindings.currentState,
      magnitudeBps: predictionMarketFindings.magnitudeBps,
    })
    .from(predictionMarketFindings)
    .where(gte(predictionMarketFindings.createdAtEpoch, cutoff));

  log.info({ total: findings.length, cutoff }, "findings-loaded");

  if (findings.length === 0) {
    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(
      OUTPUT_PATH,
      "finding_id,pattern_type,cluster_kind,old_magnitude_bps,new_magnitude_bps,would_drop,drop_reason\n",
    );
    log.info({ path: OUTPUT_PATH }, "no-findings-empty-csv-written");
    await pool.end();
    return;
  }

  const clusterIds = Array.from(new Set(findings.map((f) => f.clusterId)));
  const runIds = Array.from(new Set(findings.map((f) => f.runId)));
  const [clusterRows, snapshotRows] = await Promise.all([
    db
      .select({
        clusterId: predictionMarketClusters.clusterId,
        expectedRelationships: predictionMarketClusters.expectedRelationships,
      })
      .from(predictionMarketClusters)
      .where(inArray(predictionMarketClusters.clusterId, clusterIds)),
    // Term-structure replay needs `resolutionEpochSec` + `yesPrice` to
    // reconstruct earlier/later deterministically; findings only persist
    // `citedOdds`, no resolution dates.
    db
      .select({
        runId: predictionMarketSnapshots.runId,
        marketId: predictionMarketSnapshots.marketId,
        resolutionEpochSec: predictionMarketSnapshots.resolutionEpochSec,
        yesPriceBp: predictionMarketSnapshots.yesPriceBp,
      })
      .from(predictionMarketSnapshots)
      .where(inArray(predictionMarketSnapshots.runId, runIds)),
  ]);
  const clustersById = new Map(
    clusterRows.map((c) => [
      c.clusterId,
      (c.expectedRelationships as ExpectedRelationship[] | null) ?? [],
    ]),
  );
  const snapshotByKey = new Map<string, { resolutionEpochSec: number; yesPrice: number }>();
  for (const s of snapshotRows) {
    snapshotByKey.set(`${s.runId}::${s.marketId}`, {
      resolutionEpochSec: s.resolutionEpochSec,
      yesPrice: s.yesPriceBp / 10_000,
    });
  }

  const rows: ReplayRow[] = [];
  for (const f of findings) {
    const patternType = f.patternType as FindingPatternType;
    const involved = (f.marketsInvolved as string[]) ?? [];
    const cited = (f.currentState as FindingCurrentState | null)?.citedOdds ?? {};
    const kind = primaryKind(clustersById.get(f.clusterId) ?? null);
    const clusterKindLabel: ExpectedRelationshipKind | "unknown" = kind ?? "unknown";

    let newMag: number | null = null;
    let wouldDrop = false;
    let dropReason: ReplayRow["dropReason"] = "";

    const priceOf = (id: string): number | undefined => {
      const snap = snapshotByKey.get(`${f.runId}::${id}`);
      if (snap) return snap.yesPrice;
      const c = cited[id];
      return typeof c === "number" ? c : undefined;
    };

    switch (patternType) {
      case "logical_inconsistency":
      case "implied_contradiction": {
        if (kind === "mutually_exclusive") {
          const prices = involved
            .map((id) => priceOf(id))
            .filter((p): p is number => typeof p === "number");
          newMag = sumDeviationBps(prices);
        } else {
          // Nested or unknown: role tags unrecoverable from prices alone.
          wouldDrop = true;
          dropReason = "missing-role-tag";
        }
        break;
      }
      case "term_structure_anomaly": {
        const withDates = involved
          .map((id) => {
            const snap = snapshotByKey.get(`${f.runId}::${id}`);
            return snap ? { id, ...snap } : null;
          })
          .filter((x): x is { id: string; resolutionEpochSec: number; yesPrice: number } => !!x);
        if (withDates.length < 2) {
          wouldDrop = true;
          dropReason = "missing-role-tag";
          break;
        }
        withDates.sort((a, b) => a.resolutionEpochSec - b.resolutionEpochSec);
        const earlier = withDates[0]!;
        const later = withDates[withDates.length - 1]!;
        if (earlier.resolutionEpochSec === later.resolutionEpochSec) {
          // Cannot disambiguate earlier vs later on identical resolution.
          wouldDrop = true;
          dropReason = "missing-role-tag";
          break;
        }
        const gapBps = Math.round((earlier.yesPrice - later.yesPrice) * 10_000);
        if (gapBps <= 0) {
          wouldDrop = true;
          dropReason = "wrong-direction";
        } else {
          newMag = gapBps;
        }
        break;
      }
      case "movement_divergence":
      case "other":
      default: {
        // Symmetric / catch-all — replay reproduces the persisted magnitude.
        newMag = f.magnitudeBps;
        break;
      }
    }

    rows.push({
      findingId: f.findingId,
      patternType,
      clusterKind: clusterKindLabel,
      oldMagnitudeBps: f.magnitudeBps,
      newMagnitudeBps: newMag,
      wouldDrop,
      dropReason,
    });
  }

  // Summary by drop reason for the operator running the script.
  const summary = rows.reduce(
    (acc, r) => {
      if (r.wouldDrop) {
        acc.drops += 1;
        acc.byReason[r.dropReason] = (acc.byReason[r.dropReason] ?? 0) + 1;
      } else {
        acc.kept += 1;
      }
      return acc;
    },
    { drops: 0, kept: 0, byReason: {} as Record<string, number> },
  );
  log.info(
    {
      total: rows.length,
      kept: summary.kept,
      drops: summary.drops,
      byReason: summary.byReason,
      fpRatePct: rows.length ? Math.round((summary.drops / rows.length) * 1000) / 10 : 0,
    },
    "replay-summary",
  );

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  const header =
    "finding_id,pattern_type,cluster_kind,old_magnitude_bps,new_magnitude_bps,would_drop,drop_reason\n";
  const body = rows
    .map((r) =>
      [
        csvEscape(r.findingId),
        csvEscape(r.patternType),
        csvEscape(r.clusterKind),
        csvEscape(r.oldMagnitudeBps),
        csvEscape(r.newMagnitudeBps),
        csvEscape(r.wouldDrop),
        csvEscape(r.dropReason),
      ].join(","),
    )
    .join("\n");
  await writeFile(OUTPUT_PATH, header + body + (body ? "\n" : ""));
  log.info({ path: OUTPUT_PATH, rows: rows.length }, "csv-written");

  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "replay-failed");
  process.exitCode = 1;
});
