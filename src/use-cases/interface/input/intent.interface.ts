import type { INTENT_STATUSES } from "../../../helpers/enums/intentStatus.enum";
import type { IntentPackage } from "../output/intentParser.interface";
import type { ToolManifest } from "../output/toolManifest.types";
import type { ITokenRecord } from "../output/repository/tokenRegistry.repo";

export type { ToolManifest };
export type { ITokenRecord };
export { MissingFieldsError, InvalidFieldError, ConversationLimitError } from './intent.errors';

export interface IntentExecutionResult {
  intentId: string;
  status: INTENT_STATUSES;
  simulationReport?: { gasEstimate: string; warnings: string[] };
  humanSummary: string;
  requiresConfirmation: boolean;
  executionId?: string;
  txHash?: string;
}

export interface ParseFromHistoryResult {
  intent: IntentPackage | null;
  manifest: ToolManifest | undefined;
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

  parseFromHistory(messages: string[], userId: string): Promise<ParseFromHistoryResult>;

  searchTokens(symbol: string, chainId: number): Promise<ITokenRecord[]>;

  previewCalldata(
    intent: IntentPackage,
    manifest: ToolManifest,
  ): Promise<{ to: string; data: string; value: string } | null>;
}
