import type { ToolManifest } from "../output/toolManifest.types";
import type { ITokenRecord } from "../output/repository/tokenRegistry.repo";
import type { CompileResult } from "../output/schemaCompiler.interface";
import type { CapabilityManifest } from "../../../helpers/types/manifest";

export type { ToolManifest };
export type { ITokenRecord };
export type { CompileResult };
export type { CapabilityManifest };
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

  compileSchema(opts: {
    manifest: CapabilityManifest;
    messages: string[];
    userId: string;
    partialParams: Record<string, unknown>;
  }): Promise<CompileResult>;

  generateMissingParamQuestion(
    manifest: CapabilityManifest,
    missingFields: string[],
  ): Promise<string>;
}
