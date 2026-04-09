import type { EXECUTION_STATUSES } from "../../../../helpers/enums/executionStatus.enum";

export interface IIntentExecution {
  id: string;
  intentId: string;
  userId: string;
  smartAccountAddress: string;
  solverUsed: string;
  simulationPassed: boolean;
  simulationResult?: string | null;
  userOpHash?: string | null;
  txHash?: string | null;
  status: EXECUTION_STATUSES;
  errorMessage?: string | null;
  gasUsed?: string | null;
  feeAmount?: string | null;
  feeToken?: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IntentExecutionInit {
  id: string;
  intentId: string;
  userId: string;
  smartAccountAddress: string;
  solverUsed: string;
  simulationPassed: boolean;
  simulationResult?: string | null;
  status: EXECUTION_STATUSES;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IIntentExecutionDB {
  create(execution: IntentExecutionInit): Promise<void>;
  update(id: string, fields: Partial<Omit<IIntentExecution, "id" | "createdAtEpoch">>): Promise<void>;
  findById(id: string): Promise<IIntentExecution | undefined>;
  findByIntentId(intentId: string): Promise<IIntentExecution[]>;
}
