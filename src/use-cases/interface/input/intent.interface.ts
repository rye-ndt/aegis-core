import type { USER_INTENT_TYPE } from "../../../helpers/enums/userIntentType.enum";
import type { ToolManifest } from "../output/toolManifest.types";
import type { ITokenRecord } from "../output/repository/tokenRegistry.repo";
import type { CompileResult } from "../output/schemaCompiler.interface";

export type { ToolManifest };
export type { ITokenRecord };
export type { CompileResult };
export { DisambiguationRequiredError } from '../output/resolver.interface';
export type { ResolvedPayload } from '../output/resolver.interface';

/**
 * Schema-compilation + manifest-driven calldata service consumed by
 * capabilities. The legacy NL→solver `parseAndExecute` entry point and its
 * supporting types (IntentExecutionResult, intent statuses, conversation-limit
 * errors) were removed when the LLM `route_intent` tool unified natural
 * language into the slash-command capability dispatcher.
 */
export interface IIntentUseCase {
  searchTokens(symbol: string, chainId: number): Promise<ITokenRecord[]>;

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
