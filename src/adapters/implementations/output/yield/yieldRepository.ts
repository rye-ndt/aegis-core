import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { newUuid } from "../../../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import type {
  IYieldRepository,
  NewYieldDeposit,
  NewYieldWithdrawal,
  YieldDeposit,
  YieldPositionSnapshot,
  YieldWithdrawal,
} from "../../../../use-cases/interface/yield/IYieldRepository";
import {
  yieldDeposits,
  yieldPositionSnapshots,
  yieldWithdrawals,
} from "../sqlDB/schema";

export class DrizzleYieldRepository implements IYieldRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async recordDeposit(deposit: NewYieldDeposit): Promise<string> {
    const id = newUuid();
    const now = newCurrentUTCEpoch();
    await this.db.insert(yieldDeposits).values({
      id,
      userId: deposit.userId,
      chainId: deposit.chainId,
      protocolId: deposit.protocolId,
      tokenAddress: deposit.tokenAddress.toLowerCase(),
      amountRaw: deposit.amountRaw,
      requestedPct: deposit.requestedPct,
      idleAtRequestRaw: deposit.idleAtRequestRaw,
      status: "pending",
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });
    return id;
  }

  async updateDepositStatus(
    id: string,
    status: string,
    txHash?: string,
    userOpHash?: string,
  ): Promise<void> {
    const now = newCurrentUTCEpoch();
    await this.db
      .update(yieldDeposits)
      .set({
        status,
        txHash: txHash ?? null,
        userOpHash: userOpHash ?? null,
        updatedAtEpoch: now,
      })
      .where(eq(yieldDeposits.id, id));
  }

  async recordWithdrawal(withdrawal: NewYieldWithdrawal): Promise<string> {
    const id = newUuid();
    const now = newCurrentUTCEpoch();
    await this.db.insert(yieldWithdrawals).values({
      id,
      userId: withdrawal.userId,
      chainId: withdrawal.chainId,
      protocolId: withdrawal.protocolId,
      tokenAddress: withdrawal.tokenAddress.toLowerCase(),
      amountRaw: withdrawal.amountRaw,
      status: "submitted",
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });
    return id;
  }

  async updateWithdrawalStatus(
    id: string,
    status: string,
    txHash?: string,
    userOpHash?: string,
  ): Promise<void> {
    const now = newCurrentUTCEpoch();
    await this.db
      .update(yieldWithdrawals)
      .set({
        status,
        txHash: txHash ?? null,
        userOpHash: userOpHash ?? null,
        updatedAtEpoch: now,
      })
      .where(eq(yieldWithdrawals.id, id));
  }

  async listPositions(userId: string): Promise<YieldDeposit[]> {
    const rows = await this.db
      .select()
      .from(yieldDeposits)
      .where(eq(yieldDeposits.userId, userId));
    return rows.map(toDepositModel);
  }

  async listActiveProtocols(
    userId: string,
  ): Promise<Array<{ chainId: number; protocolId: string; tokenAddress: string }>> {
    const rows = await this.db
      .selectDistinctOn(
        [yieldDeposits.chainId, yieldDeposits.protocolId, yieldDeposits.tokenAddress],
        {
          chainId: yieldDeposits.chainId,
          protocolId: yieldDeposits.protocolId,
          tokenAddress: yieldDeposits.tokenAddress,
        },
      )
      .from(yieldDeposits)
      .where(
        and(
          eq(yieldDeposits.userId, userId),
          inArray(yieldDeposits.status, ["submitted", "confirmed"]),
        ),
      );
    return rows;
  }

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

  async getPrincipalRaw(
    userId: string,
    chainId: number,
    protocolId: string,
    tokenAddress: string,
  ): Promise<string> {
    const normalised = tokenAddress.toLowerCase();

    const deposits = await this.db
      .select({ amountRaw: yieldDeposits.amountRaw })
      .from(yieldDeposits)
      .where(
        and(
          eq(yieldDeposits.userId, userId),
          eq(yieldDeposits.chainId, chainId),
          eq(yieldDeposits.protocolId, protocolId),
          eq(yieldDeposits.tokenAddress, normalised),
          inArray(yieldDeposits.status, ["submitted", "confirmed"]),
        ),
      );

    const withdrawals = await this.db
      .select({ amountRaw: yieldWithdrawals.amountRaw })
      .from(yieldWithdrawals)
      .where(
        and(
          eq(yieldWithdrawals.userId, userId),
          eq(yieldWithdrawals.chainId, chainId),
          eq(yieldWithdrawals.protocolId, protocolId),
          eq(yieldWithdrawals.tokenAddress, normalised),
          inArray(yieldWithdrawals.status, ["submitted", "confirmed"]),
        ),
      );

    const totalDeposits = deposits.reduce((acc, r) => acc + BigInt(r.amountRaw), 0n);
    const totalWithdrawals = withdrawals.reduce((acc, r) => acc + BigInt(r.amountRaw), 0n);
    const principal = totalDeposits - totalWithdrawals;
    return (principal < 0n ? 0n : principal).toString();
  }

  async listUsersWithPositions(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ userId: yieldDeposits.userId })
      .from(yieldDeposits)
      .where(inArray(yieldDeposits.status, ["submitted", "confirmed"]));
    return rows.map((r) => r.userId);
  }
}

function toDepositModel(
  row: typeof yieldDeposits.$inferSelect,
): YieldDeposit {
  return {
    id: row.id,
    userId: row.userId,
    chainId: row.chainId,
    protocolId: row.protocolId,
    tokenAddress: row.tokenAddress,
    amountRaw: row.amountRaw,
    requestedPct: row.requestedPct,
    idleAtRequestRaw: row.idleAtRequestRaw,
    txHash: row.txHash,
    userOpHash: row.userOpHash,
    status: row.status,
    createdAtEpoch: row.createdAtEpoch,
    updatedAtEpoch: row.updatedAtEpoch,
  };
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
