import type { IIntentUseCase } from "../interface/input/intent.interface";
import type { ITokenRecord } from "../interface/output/repository/tokenRegistry.repo";
import type { ITokenRegistryService } from "../interface/output/tokenRegistry.interface";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";
import type { ISchemaCompiler, CompileResult } from "../interface/output/schemaCompiler.interface";
import type { CapabilityManifest } from "../../helpers/types/manifest";

import { createLogger } from "../../helpers/observability/logger";

const log = createLogger("intentUseCase");

/**
 * Schema-compilation service consumed by capabilities (sendCapability,
 * swapCapability) for token search and LLM-driven parameter compilation.
 *
 * The dynamic-tool-registry path (selectTool / buildRequestBody / RAG /
 * solver chain) was removed — capabilities now own their own in-code
 * `CapabilityManifest` and build calldata directly.
 */
export class IntentUseCaseImpl implements IIntentUseCase {
  constructor(
    private readonly tokenRegistryService: ITokenRegistryService,
    private readonly userProfileDB: IUserProfileDB,
    private readonly schemaCompiler: ISchemaCompiler,
  ) {
    void log;
  }

  async searchTokens(symbol: string, chainId: number): Promise<ITokenRecord[]> {
    return this.tokenRegistryService.searchBySymbol(symbol, chainId);
  }

  async compileSchema(opts: {
    manifest: CapabilityManifest;
    messages: string[];
    userId: string;
    partialParams: Record<string, unknown>;
  }): Promise<CompileResult> {
    const profile = await this.userProfileDB.findByUserId(opts.userId);
    const autoFilled: Record<string, unknown> = {
      userAddress: profile?.eoaAddress ?? "",
    };
    return this.schemaCompiler.compile({
      manifest: opts.manifest,
      messages: opts.messages,
      autoFilled,
      partialParams: opts.partialParams,
    });
  }

  async generateMissingParamQuestion(
    manifest: CapabilityManifest,
    missingFields: string[],
  ): Promise<string> {
    return this.schemaCompiler.generateQuestion({ manifest, missingFields });
  }
}
