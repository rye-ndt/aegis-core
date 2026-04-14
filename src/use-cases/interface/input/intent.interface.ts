import type { INTENT_STATUSES } from "../../../helpers/enums/intentStatus.enum";
import type { USER_INTENT_TYPE } from "../../../helpers/enums/userIntentType.enum";
import type { IntentPackage } from "../output/intentParser.interface";
import type { ToolManifest } from "../output/toolManifest.types";
import type { ITokenRecord } from "../output/repository/tokenRegistry.repo";
import type { CompileResult } from "../output/schemaCompiler.interface";

export type { ToolManifest };
export type { ITokenRecord };
export type { CompileResult };
export { MissingFieldsError, InvalidFieldError, ConversationLimitError } from './intent.errors';
export { DisambiguationRequiredError } from '../output/resolver.interface';
export type { ResolvedPayload } from '../output/resolver.interface';

export interface IntentExecutionResult {
  intentId: string;
  status: INTENT_STATUSES;
  calldata?: { to: string; data: string; value: string };
  humanSummary: string;
  requiresConfirmation: boolean;
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

  classifyIntent(messages: string[]): Promise<USER_INTENT_TYPE>;

  selectTool(
    intentType: USER_INTENT_TYPE,
    messages: string[],
  ): Promise<{ toolId: string; manifest: ToolManifest } | null>;

  compileSchema(opts: {
    manifest: ToolManifest;
    messages: string[];
    userId: string;
    partialParams: Record<string, unknown>;
  }): Promise<CompileResult>;

  buildRequestBody(opts: {
    manifest: ToolManifest;
    params: Record<string, unknown>;
    resolvedFrom: ITokenRecord | null;
    resolvedTo: ITokenRecord | null;
    userId: string;
    amountHuman?: string;
  }): Promise<{ to: string; data: string; value: string }>;

  generateMissingParamQuestion(
    manifest: ToolManifest,
    missingFields: string[],
  ): Promise<string>;
}
