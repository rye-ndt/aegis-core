/**
 * Phase C (2026-05-20) audit. Reports Polymarket `event_id` coverage and
 * group-size distribution over the latest scan run — the gating input to
 * `PREDICTION_MARKETS_EVENT_ID_CLUSTERING_ENABLED` cut-over decisions.
 *
 * Also reports how well the existing LLM clusters align with event_ids:
 * if most LLM clusters are subsumed by a single `event_id`, event-id-first
 * clustering is mostly recreating Polymarket's grouping cheaper.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/measure-event-id-coverage.ts
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import { createLogger } from "../src/helpers/observability/logger";

const log = createLogger("measureEventIdCoverage");

const MIN_CLUSTER_MEMBERS = 3;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  // Resolve once so the three downstream queries see the same run if a
  // tick lands mid-script and flips `is_latest`.
  const latest = await db.execute(sql`
    select run_id from prediction_market_runs
    where is_latest = true order by created_at_epoch desc limit 1
  `);
  if (latest.rows.length === 0) throw new Error("no latest prediction-market run found");
  const runId = (latest.rows[0] as { run_id: string }).run_id;

  const dist = await db.execute(sql`
    with groups as (
      select polymarket_event_id, count(*)::int as n
      from prediction_market_snapshots
      where run_id = ${runId} and polymarket_event_id is not null
      group by polymarket_event_id
    )
    select
      coalesce(sum(n) filter (where n >= ${MIN_CLUSTER_MEMBERS}), 0)::int as in_groups_ge3,
      count(*) filter (where n >= ${MIN_CLUSTER_MEMBERS})::int as groups_ge3,
      coalesce(sum(n) filter (where n = 2), 0)::int as in_groups_eq2,
      coalesce(sum(n) filter (where n = 1), 0)::int as singletons,
      coalesce(sum(n), 0)::int as total_with_id
    from groups
  `);
  const totalRows = await db.execute(sql`
    select count(*)::int as n
    from prediction_market_snapshots
    where run_id = ${runId}
  `);
  const total = (totalRows.rows[0] as { n: number }).n;
  const d = dist.rows[0] as {
    in_groups_ge3: number;
    groups_ge3: number;
    in_groups_eq2: number;
    singletons: number;
    total_with_id: number;
  };
  const coverage = total === 0 ? 0 : d.total_with_id / total;
  const eligible = total === 0 ? 0 : d.in_groups_ge3 / total;
  log.info(
    {
      total,
      withEventId: d.total_with_id,
      coveragePct: Math.round(coverage * 1000) / 10,
      inGroupsGe3: d.in_groups_ge3,
      groupsGe3: d.groups_ge3,
      inPairs: d.in_groups_eq2,
      singletons: d.singletons,
      eligibleForClusteringPct: Math.round(eligible * 1000) / 10,
    },
    "event-id-distribution",
  );

  const llm = await db.execute(sql`
    select
      count(*)::int as total_clusters,
      count(*) filter (where (
        select count(distinct s.polymarket_event_id)
        from prediction_market_snapshots s
        where s.run_id = c.run_id
          and s.market_id in (select jsonb_array_elements_text(c.market_ids))
      ) = 1)::int as single_event_clusters
    from prediction_market_clusters c
    where c.run_id = ${runId}
  `);
  const l = llm.rows[0] as { total_clusters: number; single_event_clusters: number };
  const subsumed = l.total_clusters === 0 ? 0 : l.single_event_clusters / l.total_clusters;
  log.info(
    {
      llmClustersInLatestRun: l.total_clusters,
      subsumedBySingleEventId: l.single_event_clusters,
      subsumedPct: Math.round(subsumed * 1000) / 10,
    },
    "llm-vs-event-id-overlap",
  );

  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exitCode = 1;
});
