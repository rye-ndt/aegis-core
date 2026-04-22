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

export interface ConfirmAndExecuteParams {
  intentId: string;
  userId: string;
  /** Pre-built calldata passed by the handler (avoids a redundant DB re-fetch). */
  calldata?: { to: string; data: string; value: string };
  /** ERC20 token address — used to record addSpent after execution. */
  tokenAddress?: string;
  /** Raw amount in token decimals — used to record addSpent after execution. */
  amountRaw?: string;
}

export interface IIntentUseCase {
  parseAndExecute(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    rawInput: string;
  }): Promise<IntentExecutionResult>;

  confirmAndExecute(params: ConfirmAndExecuteParams): Promise<IntentExecutionResult & { txHash?: string }>;


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
