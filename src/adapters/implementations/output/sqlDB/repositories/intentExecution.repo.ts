import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IIntentExecution,
  IIntentExecutionDB,
  IntentExecutionInit,
} from "../../../../../use-cases/interface/output/repository/intentExecution.repo";
import { EXECUTION_STATUSES } from "../../../../../helpers/enums/executionStatus.enum";
import { intentExecutions } from "../schema";
import { newCurrentUTCEpoch } from "../../../../../helpers/time/dateTime";

export class DrizzleIntentExecutionRepo implements IIntentExecutionDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(execution: IntentExecutionInit): Promise<void> {
    await this.db.insert(intentExecutions).values({
      id: execution.id,
      intentId: execution.intentId,
      userId: execution.userId,
      smartAccountAddress: execution.smartAccountAddress,
      solverUsed: execution.solverUsed,
      simulationPassed: execution.simulationPassed,
      simulationResult: execution.simulationResult ?? null,
      userOpHash: null,
      txHash: null,
      status: execution.status,
      errorMessage: null,
      gasUsed: null,
      feeAmount: null,
      feeToken: null,
      createdAtEpoch: execution.createdAtEpoch,
      updatedAtEpoch: execution.updatedAtEpoch,
    });
  }

  async update(id: string, fields: Partial<Omit<IIntentExecution, "id" | "createdAtEpoch">>): Promise<void> {
    await this.db
      .update(intentExecutions)
      .set({
        ...fields,
        updatedAtEpoch: newCurrentUTCEpoch(),
      })
      .where(eq(intentExecutions.id, id));
  }

  async findById(id: string): Promise<IIntentExecution | undefined> {
    const rows = await this.db
      .select()
      .from(intentExecutions)
      .where(eq(intentExecutions.id, id))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toRecord(rows[0]);
  }

  async findByIntentId(intentId: string): Promise<IIntentExecution[]> {
    const rows = await this.db
      .select()
      .from(intentExecutions)
      .where(eq(intentExecutions.intentId, intentId));
    return rows.map((r) => this.toRecord(r));
  }

  private toRecord(row: typeof intentExecutions.$inferSelect): IIntentExecution {
    return {
      id: row.id,
      intentId: row.intentId,
      userId: row.userId,
      smartAccountAddress: row.smartAccountAddress,
      solverUsed: row.solverUsed,
      simulationPassed: row.simulationPassed,
      simulationResult: row.simulationResult,
      userOpHash: row.userOpHash,
      txHash: row.txHash,
      status: row.status as EXECUTION_STATUSES,
      errorMessage: row.errorMessage,
      gasUsed: row.gasUsed,
      feeAmount: row.feeAmount,
      feeToken: row.feeToken,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
