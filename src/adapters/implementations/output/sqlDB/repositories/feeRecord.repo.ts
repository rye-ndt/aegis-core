import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IFeeRecord,
  IFeeRecordDB,
  FeeRecordInit,
} from "../../../../../use-cases/interface/output/repository/feeRecord.repo";
import { feeRecords } from "../schema";

export class DrizzleFeeRecordRepo implements IFeeRecordDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(record: FeeRecordInit): Promise<void> {
    await this.db.insert(feeRecords).values({
      id: record.id,
      executionId: record.executionId,
      userId: record.userId,
      totalFeeBps: record.totalFeeBps,
      platformFeeBps: record.platformFeeBps,
      contributorFeeBps: record.contributorFeeBps,
      feeTokenAddress: record.feeTokenAddress,
      feeAmountRaw: record.feeAmountRaw,
      platformAddress: record.platformAddress,
      contributorAddress: record.contributorAddress ?? null,
      txHash: record.txHash,
      chainId: record.chainId,
      createdAtEpoch: record.createdAtEpoch,
    });
  }

  async findByExecutionId(executionId: string): Promise<IFeeRecord | undefined> {
    const rows = await this.db
      .select()
      .from(feeRecords)
      .where(eq(feeRecords.executionId, executionId))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toRecord(rows[0]);
  }

  private toRecord(row: typeof feeRecords.$inferSelect): IFeeRecord {
    return {
      id: row.id,
      executionId: row.executionId,
      userId: row.userId,
      totalFeeBps: row.totalFeeBps,
      platformFeeBps: row.platformFeeBps,
      contributorFeeBps: row.contributorFeeBps,
      feeTokenAddress: row.feeTokenAddress,
      feeAmountRaw: row.feeAmountRaw,
      platformAddress: row.platformAddress,
      contributorAddress: row.contributorAddress,
      txHash: row.txHash,
      chainId: row.chainId,
      createdAtEpoch: row.createdAtEpoch,
    };
  }
}
