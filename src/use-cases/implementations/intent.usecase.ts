import { extractAddressFields } from "../../helpers/schema/addressFields";
import { toRaw } from "../../helpers/bigint";
import type { IIntentUseCase } from "../interface/input/intent.interface";
import type { IntentPackage } from "../interface/output/intentParser.interface";
import type { ITokenRecord } from "../interface/output/repository/tokenRegistry.repo";
import type { ITokenRegistryService } from "../interface/output/tokenRegistry.interface";
import type { ISolverRegistry } from "../interface/output/solver/solverRegistry.interface";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";
import type { USER_INTENT_TYPE } from "../../helpers/enums/userIntentType.enum";
import type { IToolManifestDB, IToolManifestRecord } from "../interface/output/repository/toolManifest.repo";
import type { IToolIndexService } from "../interface/output/toolIndex.interface";
import { deserializeManifest, type ToolManifest } from "../interface/output/toolManifest.types";
import type { ISchemaCompiler, CompileResult } from "../interface/output/schemaCompiler.interface";
import type { ICommandToolMappingDB } from "../interface/output/repository/commandToolMapping.repo";

import { createLogger } from "../../helpers/observability/logger";

const log = createLogger("intentUseCase");

/**
 * Schema-compilation + manifest-driven calldata service. Used by capabilities
 * (sendCapability, swapCapability) for token search, parameter compilation,
 * and ERC-20 transfer calldata via manifest solvers.
 *
 * The legacy `parseAndExecute` / NL→solver entry point was removed when the
 * LLM `route_intent` tool unified natural-language intents into the
 * slash-command capability dispatcher. Capabilities are the only callers now.
 */
export class IntentUseCaseImpl implements IIntentUseCase {
  constructor(
    private readonly tokenRegistryService: ITokenRegistryService,
    private readonly solverRegistry: ISolverRegistry,
    private readonly userProfileDB: IUserProfileDB,
    private readonly chainId: number,
    private readonly toolManifestDB: IToolManifestDB,
    private readonly toolIndexService: IToolIndexService | undefined,
    private readonly schemaCompiler: ISchemaCompiler,
    private readonly commandToolMappingDB?: ICommandToolMappingDB,
  ) {}

  async searchTokens(symbol: string, chainId: number): Promise<ITokenRecord[]> {
    return this.tokenRegistryService.searchBySymbol(symbol, chainId);
  }

  async selectTool(
    intentType: USER_INTENT_TYPE,
    messages: string[],
  ): Promise<{ toolId: string; manifest: ToolManifest } | null> {
    // 1. Check explicit command→tool mapping first.
    // intentType is an INTENT_COMMAND value like "/buy" — strip the slash for DB lookup.
    if (this.commandToolMappingDB) {
      const bareCommand = (intentType as string).replace(/^\//, "");
      const mapping = await this.commandToolMappingDB.findByCommand(bareCommand);
      if (mapping) {
        const record = await this.toolManifestDB.findByToolId(mapping.toolId);
        if (record?.isActive) {
          log.info({ step: "select-tool", choice: "explicit-mapping", command: bareCommand, toolId: mapping.toolId }, "selectTool resolved via command mapping");
          return { toolId: record.toolId, manifest: deserializeManifest(record) };
        }
        log.warn({ reason: "mapping_inactive", command: bareCommand, toolId: mapping.toolId }, "explicit mapping inactive — falling back to RAG");
      }
    }

    // 2. Fallback: existing RAG / ILIKE discovery.
    const query = `${intentType} ${messages.join(" ")}`;
    const manifests = await this.discoverRelevantTools(query);
    if (manifests.length === 0) return null;
    const top = manifests[0]!;
    log.info({ step: "select-tool", choice: "rag", toolId: top.toolId, candidateCount: manifests.length }, "selectTool resolved via RAG");
    return { toolId: top.toolId, manifest: top };
  }

  async compileSchema(opts: {
    manifest: ToolManifest;
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

  async buildRequestBody(opts: {
    manifest: ToolManifest;
    params: Record<string, unknown>;
    resolvedFrom: ITokenRecord | null;
    resolvedTo: ITokenRecord | null;
    userId: string;
    amountHuman?: string;
  }): Promise<{ to: string; data: string; value: string }> {
    const { manifest, resolvedFrom, resolvedTo, userId, amountHuman } = opts;
    const params = { ...opts.params };

    const addressFields = extractAddressFields(manifest.inputSchema as Record<string, unknown>);
    const [fromField, toField] = addressFields;

    if (resolvedFrom) {
      params[fromField ?? "tokenAddress"] = resolvedFrom.address;
    }
    if (resolvedTo) {
      params[toField ?? "toTokenAddress"] = resolvedTo.address;
    }

    const humanAmount =
      amountHuman ??
      (params.amountHuman as string | undefined) ??
      (params.readableAmount as string | undefined);

    if (humanAmount && resolvedFrom) {
      params.amountRaw = toRaw(humanAmount, resolvedFrom.decimals);
    }

    const profile = await this.userProfileDB.findByUserId(userId);
    const userAddress = profile?.eoaAddress ?? "";

    const intentPackage: IntentPackage = {
      action: manifest.toolId,
      params: params as Record<string, string | number | boolean | null>,
      // Bridge params.recipient → top-level field consumed by erc20_transfer step executor
      ...(params["recipient"] ? { recipient: params["recipient"] as `0x${string}` } : {}),
      confidence: 1,
      rawInput: "",
    };

    const solver = await this.solverRegistry.getSolverAsync(manifest.toolId);
    if (!solver) throw new Error(`No solver for toolId: ${manifest.toolId}`);

    const calldata = await solver.buildCalldata(intentPackage, userAddress);
    if (!calldata.to) throw new Error("Incomplete calldata");
    return calldata;
  }

  async generateMissingParamQuestion(
    manifest: ToolManifest,
    missingFields: string[],
  ): Promise<string> {
    return this.schemaCompiler.generateQuestion({ manifest, missingFields });
  }

  private async discoverRelevantTools(rawInput: string): Promise<ToolManifest[]> {
    if (this.toolIndexService) {
      try {
        log.debug({ choice: "vector-search", queryPreview: rawInput.slice(0, 80), chainId: this.chainId }, "running vector search");
        const hits = await this.toolIndexService.search(rawInput, {
          topK: 20,
          chainId: this.chainId,
          minScore: 0.3,
        });
        log.debug({ choice: "vector-hits", hitCount: hits.length, hits: hits.map((h) => `${h.toolId}(${h.score.toFixed(2)})`) }, "vector search complete");

        if (hits.length > 0) {
          const toolIds = hits.map((h) => h.toolId);
          const records = await this.toolManifestDB.findByToolIds(toolIds);
          log.debug({ choice: "vector-manifests", count: records.length }, "manifests loaded from DB");

          const scoreMap = new Map(hits.map((h) => [h.toolId, h.score]));
          records.sort((a, b) => (scoreMap.get(b.toolId) ?? 0) - (scoreMap.get(a.toolId) ?? 0));

          const resolved = this.resolveConflicts(records, rawInput);
          log.debug({ choice: "vector-resolved", tools: resolved.map((t) => t.toolId) }, "tools resolved (vector)");
          return resolved;
        }

        log.debug({ choice: "vector-empty" }, "vector search: 0 results above threshold");
        return [];
      } catch (err) {
        log.error({ err }, "vector search failed, falling back to ILIKE");
      }
    } else {
      log.debug({ choice: "ilike-fallback" }, "no toolIndexService configured, using ILIKE fallback");
    }

    const candidates = await this.toolManifestDB.search(rawInput, {
      limit: 15,
      chainId: this.chainId,
    });
    log.debug({ choice: "ilike-results", candidateCount: candidates.length, candidates: candidates.map((c) => c.toolId) }, "ILIKE fallback complete");
    const resolved = this.resolveConflicts(candidates, rawInput);
    log.debug({ choice: "ilike-resolved", tools: resolved.map((t) => t.toolId) }, "tools resolved (ILIKE)");
    return resolved;
  }

  private resolveConflicts(
    candidates: IToolManifestRecord[],
    rawInput: string,
  ): ToolManifest[] {
    const byCategory = new Map<string, IToolManifestRecord[]>();
    for (const record of candidates) {
      const bucket = byCategory.get(record.category) ?? [];
      bucket.push(record);
      byCategory.set(record.category, bucket);
    }

    const resolved: IToolManifestRecord[] = [];
    const lowerInput = rawInput.toLowerCase();

    for (const [, bucket] of byCategory) {
      if (bucket.length === 1) {
        resolved.push(bucket[0]!);
        continue;
      }
      const protocolMatch = bucket.find(
        (t) => lowerInput.includes(t.protocolName.toLowerCase()),
      );
      if (protocolMatch) {
        resolved.push(protocolMatch);
        continue;
      }
      const winner = bucket.find((t) => t.isDefault) ?? bucket[0];
      if (winner) resolved.push(winner);
    }

    return resolved.slice(0, 8).map(deserializeManifest);
  }
}
