import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { newUuid } from "../../../../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../../../../helpers/time/dateTime";
import { SeasonConfigSchema } from "../../../../../helpers/loyalty/pointsFormula";
import type {
  ILoyaltyRepository,
  LedgerEntry,
  LoyaltyActionType,
  LoyaltySeason,
  NewLedgerEntry,
} from "../../../../../use-cases/interface/output/repository/loyalty.repo";
import { loyaltyActionTypes, loyaltyPointsLedger, loyaltySeasons, users } from "../schema";

export class DrizzleLoyaltyRepo implements ILoyaltyRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async getActiveSeason(): Promise<LoyaltySeason | null> {
    const rows = await this.db
      .select()
      .from(loyaltySeasons)
      .where(eq(loyaltySeasons.status, "active"))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toSeason(row);
  }

  async getActionType(id: string): Promise<LoyaltyActionType | null> {
    const rows = await this.db
      .select()
      .from(loyaltyActionTypes)
      .where(eq(loyaltyActionTypes.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toActionType(row);
  }

  async getUserLoyaltyStatus(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ loyaltyStatus: users.loyaltyStatus })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.loyaltyStatus ?? null;
  }

  async getSumPointsToday(userId: string, seasonId: string, todayStartEpoch: number): Promise<bigint> {
    const rows = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${loyaltyPointsLedger.pointsRaw}), 0)` })
      .from(loyaltyPointsLedger)
      .where(
        and(
          eq(loyaltyPointsLedger.userId, userId),
          eq(loyaltyPointsLedger.seasonId, seasonId),
          gte(loyaltyPointsLedger.createdAtEpoch, todayStartEpoch),
        ),
      );
    return BigInt(rows[0]?.total ?? "0");
  }

  async findByIntentExecutionId(intentExecutionId: string): Promise<LedgerEntry | null> {
    const rows = await this.db
      .select()
      .from(loyaltyPointsLedger)
      .where(eq(loyaltyPointsLedger.intentExecutionId, intentExecutionId))
      .limit(1);
    return rows[0] ? toLedgerEntry(rows[0]) : null;
  }

  async insertLedgerEntry(entry: NewLedgerEntry): Promise<LedgerEntry> {
    const id = newUuid();
    const now = newCurrentUTCEpoch();
    await this.db.insert(loyaltyPointsLedger).values({
      id,
      userId: entry.userId,
      seasonId: entry.seasonId,
      actionType: entry.actionType,
      pointsRaw: entry.pointsRaw,
      intentExecutionId: entry.intentExecutionId ?? null,
      externalRef: entry.externalRef ?? null,
      formulaVersion: entry.formulaVersion,
      computedFromJson: entry.computedFromJson,
      metadataJson: entry.metadataJson ?? null,
      createdAtEpoch: now,
    });
    return {
      id,
      userId: entry.userId,
      seasonId: entry.seasonId,
      actionType: entry.actionType,
      pointsRaw: entry.pointsRaw,
      intentExecutionId: entry.intentExecutionId,
      externalRef: entry.externalRef,
      formulaVersion: entry.formulaVersion,
      computedFromJson: entry.computedFromJson,
      metadataJson: entry.metadataJson,
      createdAtEpoch: now,
    };
  }

  async getUserBalance(userId: string, seasonId: string): Promise<bigint> {
    const rows = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${loyaltyPointsLedger.pointsRaw}), 0)` })
      .from(loyaltyPointsLedger)
      .where(
        and(
          eq(loyaltyPointsLedger.userId, userId),
          eq(loyaltyPointsLedger.seasonId, seasonId),
        ),
      );
    return BigInt(rows[0]?.total ?? "0");
  }

  async getUserRank(userId: string, seasonId: string): Promise<number | null> {
    const userTotal = await this.getUserBalance(userId, seasonId);
    if (userTotal === 0n) return null;
    const rows = await this.db
      .select({ cnt: sql<string>`COUNT(*)` })
      .from(
        this.db
          .select({
            userId: loyaltyPointsLedger.userId,
            total: sql<string>`SUM(${loyaltyPointsLedger.pointsRaw})`.as("total"),
          })
          .from(loyaltyPointsLedger)
          .where(eq(loyaltyPointsLedger.seasonId, seasonId))
          .groupBy(loyaltyPointsLedger.userId)
          .as("leaderboard"),
      )
      .where(sql`"leaderboard"."total" > ${userTotal.toString()}`);
    const above = parseInt(rows[0]?.cnt ?? "0", 10);
    return above + 1;
  }

  async getLeaderboard(seasonId: string, limit: number): Promise<{ userId: string; pointsTotal: bigint; rank: number }[]> {
    const rows = await this.db
      .select({
        userId: loyaltyPointsLedger.userId,
        pointsTotal: sql<string>`SUM(${loyaltyPointsLedger.pointsRaw})`,
      })
      .from(loyaltyPointsLedger)
      .where(eq(loyaltyPointsLedger.seasonId, seasonId))
      .groupBy(loyaltyPointsLedger.userId)
      .orderBy(sql`SUM(${loyaltyPointsLedger.pointsRaw}) DESC`)
      .limit(limit);

    return rows.map((row, i) => ({
      userId: row.userId,
      pointsTotal: BigInt(row.pointsTotal),
      rank: i + 1,
    }));
  }

  async getHistory(userId: string, seasonId: string, limit: number, cursorCreatedAtEpoch?: number): Promise<LedgerEntry[]> {
    const conditions = [
      eq(loyaltyPointsLedger.userId, userId),
      eq(loyaltyPointsLedger.seasonId, seasonId),
    ];
    if (cursorCreatedAtEpoch !== undefined) {
      conditions.push(lt(loyaltyPointsLedger.createdAtEpoch, cursorCreatedAtEpoch));
    }
    const rows = await this.db
      .select()
      .from(loyaltyPointsLedger)
      .where(and(...conditions))
      .orderBy(sql`${loyaltyPointsLedger.createdAtEpoch} DESC`)
      .limit(limit);

    return rows.map(toLedgerEntry);
  }
}

function toSeason(row: typeof loyaltySeasons.$inferSelect): LoyaltySeason {
  const config = SeasonConfigSchema.parse(row.configJson);
  return {
    id: row.id,
    name: row.name,
    startsAtEpoch: row.startsAtEpoch,
    endsAtEpoch: row.endsAtEpoch,
    status: row.status,
    formulaVersion: row.formulaVersion,
    config,
    createdAtEpoch: row.createdAtEpoch,
    updatedAtEpoch: row.updatedAtEpoch,
  };
}

function toActionType(row: typeof loyaltyActionTypes.$inferSelect): LoyaltyActionType {
  return {
    id: row.id,
    displayName: row.displayName,
    defaultBase: row.defaultBase,
    isActive: row.isActive,
    createdAtEpoch: row.createdAtEpoch,
  };
}

function toLedgerEntry(row: typeof loyaltyPointsLedger.$inferSelect): LedgerEntry {
  return {
    id: row.id,
    userId: row.userId,
    seasonId: row.seasonId,
    actionType: row.actionType,
    pointsRaw: row.pointsRaw,
    intentExecutionId: row.intentExecutionId ?? null,
    externalRef: row.externalRef ?? null,
    formulaVersion: row.formulaVersion,
    computedFromJson: (row.computedFromJson ?? {}) as object,
    metadataJson: (row.metadataJson ?? null) as object | null,
    createdAtEpoch: row.createdAtEpoch,
  };
}
