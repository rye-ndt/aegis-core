import { and, eq, gt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { newUuid } from "../../../../helpers/uuid";
import type {
  IYieldRepository,
  YieldPositionSnapshot,
} from "../../../../use-cases/interface/yield/IYieldRepository";
import { yieldPositionSnapshots } from "../sqlDB/schema";

export class DrizzleYieldRepository implements IYieldRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async listSnapshots(userId: string, sinceEpoch: number): Promise<YieldPositionSnapshot[]> {
    const rows = await this.db
      .select()
      .from(yieldPositionSnapshots)
      .where(
        and(
          eq(yieldPositionSnapshots.userId, userId),
          gt(yieldPositionSnapshots.snapshotAtEpoch, sinceEpoch),
        ),
      );
    return rows.map(toSnapshotModel);
  }

  async upsertSnapshot(snapshot: Omit<YieldPositionSnapshot, "id">): Promise<void> {
    const id = newUuid();
    await this.db
      .insert(yieldPositionSnapshots)
      .values({ id, ...snapshot })
      .onConflictDoUpdate({
        target: [
          yieldPositionSnapshots.userId,
          yieldPositionSnapshots.chainId,
          yieldPositionSnapshots.protocolId,
          yieldPositionSnapshots.tokenAddress,
          yieldPositionSnapshots.snapshotDateUtc,
        ],
        set: {
          balanceRaw: sql`excluded.balance_raw`,
          principalRaw: sql`excluded.principal_raw`,
          snapshotAtEpoch: sql`excluded.snapshot_at_epoch`,
        },
      });
  }

  async listUsersWithRecentSnapshots(sinceEpoch: number): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ userId: yieldPositionSnapshots.userId })
      .from(yieldPositionSnapshots)
      .where(gt(yieldPositionSnapshots.snapshotAtEpoch, sinceEpoch));
    return rows.map((r) => r.userId);
  }
}

function toSnapshotModel(
  row: typeof yieldPositionSnapshots.$inferSelect,
): YieldPositionSnapshot {
  return {
    id: row.id,
    userId: row.userId,
    chainId: row.chainId,
    protocolId: row.protocolId,
    tokenAddress: row.tokenAddress,
    snapshotDateUtc: row.snapshotDateUtc,
    balanceRaw: row.balanceRaw,
    principalRaw: row.principalRaw,
    snapshotAtEpoch: row.snapshotAtEpoch,
  };
}
