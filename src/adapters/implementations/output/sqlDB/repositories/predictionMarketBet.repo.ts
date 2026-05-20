import { and, eq, gt, inArray, lt, notInArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { newCurrentUTCEpoch } from "../../../../../helpers/time/dateTime";
import {
  BET_STATE_TRANSITIONS,
  IllegalBetTransitionError,
  type BetIntentRow,
  type BetIntentStatus,
  type BetRow,
  type BetStatus,
  type IPredictionMarketBetRepository,
  type InsertBetInput,
  type InsertBetIntentInput,
  type PositionRow,
  type PositionStatus,
  type SetupStep,
  type UserSetupRow,
} from "../../../../../use-cases/interface/predictionMarket/IPredictionMarketBetRepository";
import {
  predictionMarketBetIntents,
  predictionMarketBets,
  predictionMarketPositions,
  predictionMarketUserSetup,
} from "../schema";

const ACTIVE_INTENT_STATUSES: BetIntentStatus[] = [
  "awaiting_amount",
  "awaiting_confirm",
  "executing",
];

/**
 * Bets we still consider "in flight" for the purposes of the per-user
 * concurrency lock. PARTIAL is included because a partial fill leaves residual
 * USDC on the EOA pending refund — confirming a second bet on top would race
 * with the refund UserOp. FILLED/UNFILLED/FAILED are the only safe statuses
 * to ignore here.
 */
const TERMINAL_NON_PENDING_STATUSES: BetStatus[] = ["FILLED", "UNFILLED", "FAILED"];

export class DrizzlePredictionMarketBetRepo implements IPredictionMarketBetRepository {
  constructor(private readonly db: NodePgDatabase) {}

  // ── User setup ──────────────────────────────────────────────────────────

  async upsertUserSetup(row: UserSetupRow): Promise<void> {
    await this.db
      .insert(predictionMarketUserSetup)
      .values({
        userId: row.userId,
        polygonScaAddress: row.polygonScaAddress,
        polygonEoaAddress: row.polygonEoaAddress,
        bootstrapBridgeIntentId: row.bootstrapBridgeIntentId,
        approvalsTxHashes: row.approvalsTxHashes,
        polymarketCredsEnc: row.polymarketCredsEnc,
        setupStep: row.setupStep,
        createdAtEpoch: row.createdAtEpoch,
        updatedAtEpoch: row.updatedAtEpoch,
      })
      .onConflictDoUpdate({
        target: predictionMarketUserSetup.userId,
        set: {
          polygonScaAddress: row.polygonScaAddress,
          polygonEoaAddress: row.polygonEoaAddress,
          updatedAtEpoch: row.updatedAtEpoch,
        },
      });
  }

  async getUserSetup(userId: string): Promise<UserSetupRow | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketUserSetup)
      .where(eq(predictionMarketUserSetup.userId, userId))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      userId: r.userId,
      polygonScaAddress: r.polygonScaAddress,
      polygonEoaAddress: r.polygonEoaAddress,
      bootstrapBridgeIntentId: r.bootstrapBridgeIntentId,
      approvalsTxHashes: (r.approvalsTxHashes as string[] | null) ?? null,
      polymarketCredsEnc: r.polymarketCredsEnc,
      setupStep: r.setupStep as SetupStep,
      createdAtEpoch: r.createdAtEpoch,
      updatedAtEpoch: r.updatedAtEpoch,
    };
  }

  async updateSetupStep(userId: string, step: SetupStep): Promise<void> {
    await this.db
      .update(predictionMarketUserSetup)
      .set({ setupStep: step, updatedAtEpoch: newCurrentUTCEpoch() })
      .where(eq(predictionMarketUserSetup.userId, userId));
  }

  async setBootstrapBridgeIntentId(userId: string, intentId: string): Promise<void> {
    await this.db
      .update(predictionMarketUserSetup)
      .set({ bootstrapBridgeIntentId: intentId, updatedAtEpoch: newCurrentUTCEpoch() })
      .where(eq(predictionMarketUserSetup.userId, userId));
  }

  async setApprovalsTxHashes(userId: string, hashes: string[]): Promise<void> {
    await this.db
      .update(predictionMarketUserSetup)
      .set({ approvalsTxHashes: hashes, updatedAtEpoch: newCurrentUTCEpoch() })
      .where(eq(predictionMarketUserSetup.userId, userId));
  }

  async setPolymarketCredsEnc(userId: string, envelope: string): Promise<void> {
    await this.db
      .update(predictionMarketUserSetup)
      .set({ polymarketCredsEnc: envelope, updatedAtEpoch: newCurrentUTCEpoch() })
      .where(eq(predictionMarketUserSetup.userId, userId));
  }

  // ── Bet intents ─────────────────────────────────────────────────────────

  async insertBetIntent(input: InsertBetIntentInput): Promise<BetIntentRow> {
    const now = newCurrentUTCEpoch();
    const row: BetIntentRow = {
      id: input.id,
      userId: input.userId,
      findingId: input.findingId,
      marketId: input.marketId,
      side: input.side,
      outcomeTokenId: input.outcomeTokenId,
      stakeUsdcCents: null,
      refPriceBps: input.refPriceBps,
      status: "awaiting_amount",
      betId: null,
      expiresAtEpoch: input.expiresAtEpoch,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    };
    await this.db.insert(predictionMarketBetIntents).values({
      id: row.id,
      userId: row.userId,
      findingId: row.findingId,
      marketId: row.marketId,
      side: row.side,
      outcomeTokenId: row.outcomeTokenId,
      stakeUsdcCents: row.stakeUsdcCents,
      refPriceBps: row.refPriceBps,
      status: row.status,
      betId: row.betId,
      expiresAtEpoch: row.expiresAtEpoch,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    });
    return row;
  }

  async getBetIntent(id: string): Promise<BetIntentRow | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketBetIntents)
      .where(eq(predictionMarketBetIntents.id, id))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return this.intentRow(r);
  }

  async setBetIntentAmount(id: string, stakeUsdcCents: number): Promise<void> {
    await this.db
      .update(predictionMarketBetIntents)
      .set({
        stakeUsdcCents,
        status: "awaiting_confirm",
        updatedAtEpoch: newCurrentUTCEpoch(),
      })
      .where(eq(predictionMarketBetIntents.id, id));
  }

  async setBetIntentStatus(
    id: string,
    status: BetIntentStatus,
    betId?: string,
  ): Promise<void> {
    const set: Record<string, unknown> = {
      status,
      updatedAtEpoch: newCurrentUTCEpoch(),
    };
    if (betId !== undefined) set.betId = betId;
    await this.db
      .update(predictionMarketBetIntents)
      .set(set)
      .where(eq(predictionMarketBetIntents.id, id));
  }

  async findActiveIntentForUser(userId: string): Promise<BetIntentRow | null> {
    // Filter out expired intents — they're stale, not "active". Without this
    // filter, a stuck `executing` intent (e.g. a bet whose mini-app deeplink
    // was never completed) would shadow every subsequent `place_bet:` click
    // and force `submitAmount` to reject with `wrong-status`.
    const nowEpoch = Math.floor(Date.now() / 1000);
    const rows = await this.db
      .select()
      .from(predictionMarketBetIntents)
      .where(
        and(
          eq(predictionMarketBetIntents.userId, userId),
          inArray(predictionMarketBetIntents.status, ACTIVE_INTENT_STATUSES),
          gt(predictionMarketBetIntents.expiresAtEpoch, nowEpoch),
        ),
      )
      .limit(1);
    const r = rows[0];
    return r ? this.intentRow(r) : null;
  }

  // ── Bets ────────────────────────────────────────────────────────────────

  async insertBet(input: InsertBetInput): Promise<BetRow> {
    const now = newCurrentUTCEpoch();
    const row: BetRow = {
      id: input.id,
      userId: input.userId,
      intentId: input.intentId,
      findingId: input.findingId,
      marketId: input.marketId,
      outcomeTokenId: input.outcomeTokenId,
      side: input.side,
      stakeUsdcCents: input.stakeUsdcCents,
      refPriceBps: input.refPriceBps,
      clientOrderId: input.clientOrderId,
      bridgeIntentId: null,
      scaToEoaTxHash: null,
      polymarketOrderId: null,
      status: "INITIATED",
      filledShares: null,
      filledAvgPriceBps: null,
      failureReason: null,
      betKind: input.betKind,
      parentBetId: input.parentBetId,
      refundRequired: false,
      refundTxHash: null,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    };
    await this.db.insert(predictionMarketBets).values(row);
    return row;
  }

  async getBet(id: string): Promise<BetRow | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketBets)
      .where(eq(predictionMarketBets.id, id))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return this.betRow(r);
  }

  async updateBetStatus(
    id: string,
    next: BetStatus,
    patch: Partial<BetRow> = {},
  ): Promise<void> {
    // Read-modify-write under an SQL row lock — prevents two concurrent
    // transitions from observing the same `current` and both passing the
    // legality check. The lock is released when the surrounding txn commits;
    // for a single-statement use-case this is effectively atomic.
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ status: predictionMarketBets.status })
        .from(predictionMarketBets)
        .where(eq(predictionMarketBets.id, id))
        .for("update")
        .limit(1);
      const cur = rows[0];
      if (!cur) throw new Error(`BET_NOT_FOUND:${id}`);
      const current = cur.status as BetStatus;
      const allowed = BET_STATE_TRANSITIONS[current] ?? [];
      if (!allowed.includes(next)) {
        throw new IllegalBetTransitionError(current, next);
      }
      const set: Record<string, unknown> = {
        status: next,
        updatedAtEpoch: newCurrentUTCEpoch(),
      };
      for (const k of [
        "bridgeIntentId",
        "scaToEoaTxHash",
        "polymarketOrderId",
        "filledShares",
        "filledAvgPriceBps",
        "failureReason",
      ] as const) {
        if (patch[k] !== undefined) set[k] = patch[k];
      }
      await tx
        .update(predictionMarketBets)
        .set(set)
        .where(eq(predictionMarketBets.id, id));
    });
  }

  async setBetFailure(id: string, reason: string): Promise<void> {
    await this.updateBetStatus(id, "FAILED", { failureReason: reason });
  }

  async setBetRefundRequired(id: string, required: boolean): Promise<void> {
    await this.db
      .update(predictionMarketBets)
      .set({ refundRequired: required, updatedAtEpoch: newCurrentUTCEpoch() })
      .where(eq(predictionMarketBets.id, id));
  }

  async setBetRefundTxHash(id: string, txHash: string): Promise<void> {
    await this.db
      .update(predictionMarketBets)
      .set({ refundTxHash: txHash, refundRequired: false, updatedAtEpoch: newCurrentUTCEpoch() })
      .where(eq(predictionMarketBets.id, id));
  }

  async countOpenBetsForUser(userId: string): Promise<number> {
    const rows = await this.db
      .select({ id: predictionMarketBets.id })
      .from(predictionMarketBets)
      .where(
        and(
          eq(predictionMarketBets.userId, userId),
          notInArray(predictionMarketBets.status, TERMINAL_NON_PENDING_STATUSES),
        ),
      );
    return rows.length;
  }

  async findActiveBetForUser(userId: string): Promise<BetRow | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketBets)
      .where(
        and(
          eq(predictionMarketBets.userId, userId),
          notInArray(predictionMarketBets.status, TERMINAL_NON_PENDING_STATUSES),
        ),
      )
      .limit(1);
    const r = rows[0];
    return r ? this.betRow(r) : null;
  }

  async listStuckBets(olderThanEpoch: number, limit: number): Promise<BetRow[]> {
    // Two cohorts share the same row condition: non-terminal bets that have
    // gone quiet (mini-app likely closed), AND PARTIAL bets whose refund
    // hasn't landed. Both want a re-advance.
    const rows = await this.db
      .select()
      .from(predictionMarketBets)
      .where(
        and(
          lt(predictionMarketBets.updatedAtEpoch, olderThanEpoch),
          sql`(${predictionMarketBets.status} NOT IN ('FILLED', 'UNFILLED', 'FAILED')
               OR (${predictionMarketBets.status} = 'PARTIAL'
                   AND ${predictionMarketBets.refundRequired} = true
                   AND ${predictionMarketBets.refundTxHash} IS NULL))`,
        ),
      )
      .limit(limit);
    return rows.map((r) => this.betRow(r));
  }

  // ── Positions ───────────────────────────────────────────────────────────

  async insertPosition(row: PositionRow): Promise<void> {
    await this.db.insert(predictionMarketPositions).values(row);
  }

  async listOpenPositionsForUser(userId: string): Promise<PositionRow[]> {
    const rows = await this.db
      .select()
      .from(predictionMarketPositions)
      .where(
        and(
          eq(predictionMarketPositions.userId, userId),
          inArray(predictionMarketPositions.status, ["open", "closing"]),
        ),
      );
    return rows.map((r) => this.positionRow(r));
  }

  async getPosition(id: string): Promise<PositionRow | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketPositions)
      .where(eq(predictionMarketPositions.id, id))
      .limit(1);
    const r = rows[0];
    return r ? this.positionRow(r) : null;
  }

  async updatePositionStatus(
    id: string,
    status: PositionStatus,
    patch: Partial<PositionRow> = {},
  ): Promise<void> {
    const set: Record<string, unknown> = { status };
    for (const k of [
      "currentValueUsdcCents",
      "resolvedOutcome",
      "realizedPnlUsdcCents",
      "closingBetId",
      "closedAtEpoch",
    ] as const) {
      if (patch[k] !== undefined) set[k] = patch[k];
    }
    await this.db
      .update(predictionMarketPositions)
      .set(set)
      .where(eq(predictionMarketPositions.id, id));
  }

  async decrementPositionShares(id: string, delta: string): Promise<void> {
    // sizeShares is text(decimal-string); subtract via numeric cast so we
    // don't lose precision on shares (Polymarket returns up to 6 dp).
    await this.db
      .update(predictionMarketPositions)
      .set({
        sizeShares: sql`((${predictionMarketPositions.sizeShares}::numeric) - (${delta}::numeric))::text`,
      })
      .where(eq(predictionMarketPositions.id, id));
  }

  async findPositionByOpeningBetId(betId: string): Promise<PositionRow | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketPositions)
      .where(eq(predictionMarketPositions.openingBetId, betId))
      .limit(1);
    const r = rows[0];
    return r ? this.positionRow(r) : null;
  }

  async findPositionByClosingBetId(betId: string): Promise<PositionRow | null> {
    const rows = await this.db
      .select()
      .from(predictionMarketPositions)
      .where(eq(predictionMarketPositions.closingBetId, betId))
      .limit(1);
    const r = rows[0];
    return r ? this.positionRow(r) : null;
  }

  async listUsersWithOpenPositions(): Promise<
    Array<{
      userId: string;
      polygonEoaAddress: string;
      polymarketCredsEnc: string | null;
    }>
  > {
    const rows = await this.db
      .selectDistinct({
        userId: predictionMarketPositions.userId,
        polygonEoaAddress: predictionMarketUserSetup.polygonEoaAddress,
        polymarketCredsEnc: predictionMarketUserSetup.polymarketCredsEnc,
      })
      .from(predictionMarketPositions)
      .innerJoin(
        predictionMarketUserSetup,
        eq(predictionMarketUserSetup.userId, predictionMarketPositions.userId),
      )
      .where(inArray(predictionMarketPositions.status, ["open", "closing"]));
    return rows;
  }

  // ── Mappers ─────────────────────────────────────────────────────────────

  private intentRow(r: typeof predictionMarketBetIntents.$inferSelect): BetIntentRow {
    return {
      id: r.id,
      userId: r.userId,
      findingId: r.findingId,
      marketId: r.marketId,
      side: r.side,
      outcomeTokenId: r.outcomeTokenId,
      stakeUsdcCents: r.stakeUsdcCents,
      refPriceBps: r.refPriceBps,
      status: r.status as BetIntentStatus,
      betId: r.betId,
      expiresAtEpoch: r.expiresAtEpoch,
      createdAtEpoch: r.createdAtEpoch,
      updatedAtEpoch: r.updatedAtEpoch,
    };
  }

  private betRow(r: typeof predictionMarketBets.$inferSelect): BetRow {
    return {
      id: r.id,
      userId: r.userId,
      intentId: r.intentId,
      findingId: r.findingId,
      marketId: r.marketId,
      outcomeTokenId: r.outcomeTokenId,
      side: r.side,
      stakeUsdcCents: r.stakeUsdcCents,
      refPriceBps: r.refPriceBps,
      clientOrderId: r.clientOrderId,
      bridgeIntentId: r.bridgeIntentId,
      scaToEoaTxHash: r.scaToEoaTxHash,
      polymarketOrderId: r.polymarketOrderId,
      status: r.status as BetStatus,
      filledShares: r.filledShares,
      filledAvgPriceBps: r.filledAvgPriceBps,
      failureReason: r.failureReason,
      betKind: r.betKind as "open" | "close",
      parentBetId: r.parentBetId,
      refundRequired: r.refundRequired,
      refundTxHash: r.refundTxHash,
      createdAtEpoch: r.createdAtEpoch,
      updatedAtEpoch: r.updatedAtEpoch,
    };
  }

  private positionRow(r: typeof predictionMarketPositions.$inferSelect): PositionRow {
    return {
      id: r.id,
      userId: r.userId,
      marketId: r.marketId,
      outcomeTokenId: r.outcomeTokenId,
      side: r.side,
      sizeShares: r.sizeShares,
      entryPriceAvgBps: r.entryPriceAvgBps,
      entryStakeUsdcCents: r.entryStakeUsdcCents,
      openingBetId: r.openingBetId,
      closingBetId: r.closingBetId,
      currentValueUsdcCents: r.currentValueUsdcCents,
      status: r.status as PositionStatus,
      resolvedOutcome: r.resolvedOutcome,
      realizedPnlUsdcCents: r.realizedPnlUsdcCents,
      openedAtEpoch: r.openedAtEpoch,
      closedAtEpoch: r.closedAtEpoch,
    };
  }
}
