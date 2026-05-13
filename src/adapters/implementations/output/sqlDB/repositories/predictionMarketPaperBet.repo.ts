import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { createLogger } from "../../../../../helpers/observability/logger";
import {
  PAPER_BET_NULL_SUBJECT_BUCKET,
  type AggregatePerformanceArgs,
  type IPredictionMarketPaperBetRepository,
  type PerformanceBucket,
} from "../../../../../use-cases/interface/predictionMarket/IPredictionMarketPaperBetRepository";
import type {
  DetectorSource,
  PaperBet,
  PaperBetInsert,
  PaperBetResolutionPatch,
  PaperBetSide,
  PaperBetStatus,
} from "../../../../../use-cases/interface/predictionMarket/PaperBetTypes";
import { predictionMarketPaperBets } from "../schema";

const log = createLogger("PaperBetRepo");

type Row = typeof predictionMarketPaperBets.$inferSelect;

export class DrizzlePredictionMarketPaperBetRepo implements IPredictionMarketPaperBetRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async insert(row: PaperBetInsert): Promise<PaperBet> {
    const [r] = await this.db
      .insert(predictionMarketPaperBets)
      .values({
        userId: row.userId,
        findingId: row.findingId,
        clusterId: row.clusterId,
        marketId: row.marketId,
        subject: row.subject,
        side: row.side,
        stakeUsdcCents: row.stakeUsdcCents,
        entryPriceBps: row.entryPriceBps,
        sharesE6: row.sharesE6,
        detectorSource: row.detectorSource,
      })
      .returning();
    log.info(
      {
        findingId: row.findingId,
        userId: row.userId,
        side: row.side,
        stakeUsdcCents: row.stakeUsdcCents,
        detectorSource: row.detectorSource,
      },
      "paper-bet inserted",
    );
    return this.toPaperBet(r);
  }

  async findById(id: string): Promise<PaperBet | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketPaperBets)
      .where(eq(predictionMarketPaperBets.id, id))
      .limit(1);
    const r = rows[0];
    return r ? this.toPaperBet(r) : null;
  }

  async listByUser(
    userId: string,
    opts: { limit?: number; status?: PaperBetStatus } = {},
  ): Promise<PaperBet[]> {
    const where = opts.status
      ? and(
          eq(predictionMarketPaperBets.userId, userId),
          eq(predictionMarketPaperBets.status, opts.status),
        )
      : eq(predictionMarketPaperBets.userId, userId);
    const q = this.db
      .select()
      .from(predictionMarketPaperBets)
      .where(where)
      .orderBy(desc(predictionMarketPaperBets.entryAt));
    const rows = opts.limit ? await q.limit(opts.limit) : await q;
    return rows.map((r) => this.toPaperBet(r));
  }

  async listOpenByMarkets(marketIds: string[]): Promise<PaperBet[]> {
    if (marketIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(predictionMarketPaperBets)
      .where(
        and(
          eq(predictionMarketPaperBets.status, "open"),
          inArray(predictionMarketPaperBets.marketId, marketIds),
        ),
      );
    return rows.map((r) => this.toPaperBet(r));
  }

  async listOpenMarketIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ marketId: predictionMarketPaperBets.marketId })
      .from(predictionMarketPaperBets)
      .where(eq(predictionMarketPaperBets.status, "open"));
    return rows.map((r) => r.marketId);
  }

  async resolveMany(patches: PaperBetResolutionPatch[]): Promise<number> {
    if (patches.length === 0) return 0;
    let resolved = 0;
    await this.db.transaction(async (tx) => {
      for (const p of patches) {
        // Only flip rows that are still open — a re-run of the resolution job
        // must not overwrite an already-settled row's payout/PnL.
        const result = await tx
          .update(predictionMarketPaperBets)
          .set({
            status: "resolved",
            outcome: p.outcome,
            payoutUsdcCents: p.payoutUsdcCents,
            realizedPnlUsdcCents: p.realizedPnlUsdcCents,
            resolvedAt: new Date(),
          })
          .where(
            and(
              eq(predictionMarketPaperBets.id, p.id),
              eq(predictionMarketPaperBets.status, "open"),
            ),
          )
          .returning({ id: predictionMarketPaperBets.id });
        resolved += result.length;
      }
    });
    log.info({ count: resolved, betCount: patches.length }, "paper-bets resolved");
    return resolved;
  }

  async aggregatePerformance(args: AggregatePerformanceArgs): Promise<PerformanceBucket[]> {
    const status: PaperBetStatus = args.status ?? "resolved";
    log.info(
      { groupBy: args.groupBy, userId: args.userId, status },
      "aggregate performance",
    );

    // Drizzle's typed aggregation builder is awkward for the conditional
    // group-by axis — drop to raw SQL with an inline placeholder for the
    // grouping expression. All identifiers are static; the only runtime input
    // is a UUID parameter, bound via drizzle's parameter system (no string
    // interpolation from user input).
    const groupExpr = this.groupByExpr(args.groupBy);
    const userClause = args.userId
      ? sql`AND user_id = ${args.userId}`
      : sql``;
    const sinceClause = args.since
      ? sql`AND entry_at >= ${args.since.toISOString()}`
      : sql``;
    // `overall` collapses to no GROUP BY at all — Postgres rejects a constant
    // expression in GROUP BY ("non-integer constant in GROUP BY"), and we want
    // a single-row result anyway. For the other axes we GROUP BY positional
    // ordinal `1` (the first select column) so the bucket-key expression isn't
    // re-parameterized into a second placeholder that PG can't equate to the
    // SELECT-list expression.
    const groupClause = args.groupBy === "overall" ? sql`` : sql`GROUP BY 1`;

    // `percentile_cont(0.5)` is exact and cheap on the index-sized buckets we
    // expect (≤ tens of thousands per axis). Returns NULL on empty groups —
    // wrapped in COALESCE → 0 for a zero-sentinel that the JS layer trusts.
    const rows = await this.db.execute(sql`
      SELECT
        ${groupExpr} AS bucket_key,
        COUNT(*)::int AS bet_count,
        COALESCE(SUM(stake_usdc_cents), 0)::bigint AS total_stake,
        COALESCE(SUM(payout_usdc_cents), 0)::bigint AS total_payout,
        COALESCE(SUM(realized_pnl_usdc_cents), 0)::bigint AS total_pnl,
        COUNT(*) FILTER (WHERE realized_pnl_usdc_cents > 0)::int AS wins,
        COUNT(*) FILTER (WHERE realized_pnl_usdc_cents <= 0)::int AS losses,
        COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY stake_usdc_cents), 0)::bigint AS median_stake,
        COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY realized_pnl_usdc_cents), 0)::bigint AS median_pnl
      FROM prediction_market_paper_bets
      WHERE status = ${status}
      ${userClause}
      ${sinceClause}
      ${groupClause}
    `);

    const out: PerformanceBucket[] = [];
    for (const r of rows.rows as Array<Record<string, unknown>>) {
      const totalStake = Number(r.total_stake ?? 0);
      const totalPayout = Number(r.total_payout ?? 0);
      const totalPnl = Number(r.total_pnl ?? 0);
      const wins = Number(r.wins ?? 0);
      const losses = Number(r.losses ?? 0);
      const settled = wins + losses;
      out.push({
        key: (r.bucket_key as string | null) ?? PAPER_BET_NULL_SUBJECT_BUCKET,
        betCount: Number(r.bet_count ?? 0),
        totalStakeUsdcCents: totalStake,
        totalPayoutUsdcCents: totalPayout,
        totalPnlUsdcCents: totalPnl,
        wins,
        losses,
        winRateBps: settled === 0 ? 0 : Math.round((wins / settled) * 10_000),
        roiBps: totalStake === 0 ? 0 : Math.round((totalPnl / totalStake) * 10_000),
        medianStakeUsdcCents: Math.round(Number(r.median_stake ?? 0)),
        medianPnlUsdcCents: Math.round(Number(r.median_pnl ?? 0)),
      });
    }
    return out;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private groupByExpr(groupBy: AggregatePerformanceArgs["groupBy"]) {
    switch (groupBy) {
      case "overall":
        return sql`'overall'`;
      case "subject":
        // NULL → sentinel bucket so unsubjected (LLM-clustered) rows surface.
        return sql`COALESCE(subject, ${PAPER_BET_NULL_SUBJECT_BUCKET})`;
      case "clusterId":
        return sql`cluster_id::text`;
      case "detectorSource":
        return sql`detector_source`;
    }
  }

  private toPaperBet(r: Row): PaperBet {
    return {
      id: r.id,
      userId: r.userId,
      findingId: r.findingId,
      clusterId: r.clusterId,
      marketId: r.marketId,
      subject: r.subject,
      side: r.side as PaperBetSide,
      stakeUsdcCents: r.stakeUsdcCents,
      entryPriceBps: r.entryPriceBps,
      sharesE6: r.sharesE6,
      detectorSource: r.detectorSource as DetectorSource,
      status: r.status as PaperBetStatus,
      outcome: (r.outcome as PaperBetSide | null) ?? null,
      payoutUsdcCents: r.payoutUsdcCents,
      realizedPnlUsdcCents: r.realizedPnlUsdcCents,
      entryAt: r.entryAt,
      resolvedAt: r.resolvedAt,
    };
  }
}
