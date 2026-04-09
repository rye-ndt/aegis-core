import type { INTENT_STATUSES } from "../../../helpers/enums/intentStatus.enum";
import type { SimulationReport, IntentPackage } from "../output/intentParser.interface";

export interface IntentExecutionResult {
  intentId: string;
  status: INTENT_STATUSES;
  simulationReport?: SimulationReport;
  humanSummary: string;
  requiresConfirmation: boolean;
  executionId?: string;
  txHash?: string;
}

export interface IIntentUseCase {
  parseAndExecute(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    rawInput: string;
  }): Promise<IntentExecutionResult>;

  confirmAndExecute(params: {
    intentId: string;
    userId: string;
  }): Promise<IntentExecutionResult>;

  getHistory(userId: string): Promise<IntentPackage[]>;
}
