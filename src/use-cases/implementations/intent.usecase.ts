import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { toErrorMessage } from "../../helpers/errors/toErrorMessage";
import { CHAIN_CONFIG } from "../../helpers/chainConfig";
import { extractAddressFields } from "../../helpers/schema/addressFields";
import { newUuid } from "../../helpers/uuid";
import { INTENT_STATUSES } from "../../helpers/enums/intentStatus.enum";
import { INTENT_ACTION } from "../../helpers/enums/intentAction.enum";
import { USER_INTENT_TYPE } from "../../helpers/enums/userIntentType.enum";
import { toRaw } from "../../helpers/bigint";
import type {
  IIntentUseCase,
  IntentExecutionResult,
} from "../interface/input/intent.interface";
import type { IntentPackage } from "../interface/output/intentParser.interface";
import type { IIntentParser } from "../interface/output/intentParser.interface";
import type { ITokenRecord } from "../interface/output/repository/tokenRegistry.repo";
import type { ITokenRegistryService } from "../interface/output/tokenRegistry.interface";
import type { ISolverRegistry } from "../interface/output/solver/solverRegistry.interface";
import type { IIntentDB } from "../interface/output/repository/intent.repo";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";
import type { IMessageDB } from "../interface/output/repository/message.repo";
import { MESSAGE_ROLE } from "../../helpers/enums/messageRole.enum";
import { MissingFieldsError, ConversationLimitError, InvalidFieldError } from "../interface/input/intent.errors";
import { validateIntent } from "./validateIntent";
import type { IToolManifestDB, IToolManifestRecord } from "../interface/output/repository/toolManifest.repo";
import type { IToolIndexService } from "../interface/output/toolIndex.interface";
import { deserializeManifest, type ToolManifest } from "../interface/output/toolManifest.types";
import type { IIntentClassifier } from "../interface/output/intentClassifier.interface";
import type { ISchemaCompiler, CompileResult } from "../interface/output/schemaCompiler.interface";
import type { ICommandToolMappingDB } from "../interface/output/repository/commandToolMapping.repo";

import { createLogger } from "../../helpers/observability/logger";

const log = createLogger("intentUseCase");
const CONFIDENCE_THRESHOLD = 0.7;

export class IntentUseCaseImpl implements IIntentUseCase {
  constructor(
    private readonly intentParser: IIntentParser,
    private readonly tokenRegistryService: ITokenRegistryService,
    private readonly solverRegistry: ISolverRegistry,
    private readonly intentDB: IIntentDB,
    private readonly userProfileDB: IUserProfileDB,
    private readonly messageDB: IMessageDB,
    private readonly chainId: number,
    private readonly toolManifestDB: IToolManifestDB,
    private readonly toolIndexService: IToolIndexService | undefined,
    private readonly intentClassifier: IIntentClassifier,
    private readonly schemaCompiler: ISchemaCompiler,
    private readonly commandToolMappingDB?: ICommandToolMappingDB,
  ) {}

  async parseAndExecute(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    rawInput: string;
  }): Promise<IntentExecutionResult> {
    const now = newCurrentUTCEpoch();
    const intentId = newUuid();

    // 1. Build sliding window of last 10 user messages for this conversation.
    const priorMessages = await this.messageDB.findByConversationId(
      params.conversationId,
    );
    const priorUserContent = priorMessages
      .filter((m) => m.role === MESSAGE_ROLE.USER)
      .slice(-9)
      .map((m) => m.content);
    const messages = [...priorUserContent, params.rawInput];

    // 2. Discover relevant dynamic tools and parse intent
    log.info({ step: "parse-start", userId: params.userId, inputPreview: params.rawInput.slice(0, 80) }, "parseAndExecute");
    const relevantManifests = await this.discoverRelevantTools(params.rawInput);

    let intent: IntentPackage | null;
    try {
      log.debug({ choice: "intent-parse", messageCount: messages.length, manifestCount: relevantManifests.length }, "calling intentParser");
      intent = await this.intentParser.parse(messages, params.userId, relevantManifests);
      log.info({ step: "intent-parsed", action: intent?.action ?? null, confidence: intent?.confidence ?? null }, "intent parsed");

      let manifest: ToolManifest | undefined;
      if (intent !== null && !Object.values(INTENT_ACTION).includes(intent.action as INTENT_ACTION)) {
        manifest = relevantManifests.find((m) => m.toolId === intent!.action);
      }
      if (intent !== null) validateIntent(intent, messages.length, manifest);
    } catch (err) {
      if (err instanceof ConversationLimitError) {
        await this.messageDB.deleteByConversationId(params.conversationId);
        return {
          intentId,
          status: INTENT_STATUSES.REJECTED,
          humanSummary:
            err.message +
            "\n\nYour conversation has been reset. Please send a new complete request.",
          requiresConfirmation: false,
        };
      }
      if (
        err instanceof MissingFieldsError ||
        err instanceof InvalidFieldError
      ) {
        return {
          intentId,
          status: INTENT_STATUSES.REJECTED,
          humanSummary: err.prompt,
          requiresConfirmation: false,
        };
      }
      throw err;
    }

    if (intent === null) {
      return {
        intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: "No on-chain action detected in your message.",
        requiresConfirmation: false,
      };
    }

    // 3. Confidence check
    log.debug({ choice: "confidence-check", confidence: intent.confidence, threshold: CONFIDENCE_THRESHOLD, action: intent.action }, "confidence check");
    if (
      intent.confidence < CONFIDENCE_THRESHOLD ||
      intent.action === INTENT_ACTION.UNKNOWN
    ) {
      await this.intentDB.create({
        id: intentId,
        userId: params.userId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        rawInput: params.rawInput,
        parsedJson: JSON.stringify(intent),
        status: INTENT_STATUSES.REJECTED,
        rejectionReason: "Low confidence or unrecognized intent",
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });
      return {
        intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: `I couldn't understand that intent clearly (confidence: ${Math.round(intent.confidence * 100)}%). Could you rephrase? For example: "Swap 100 USDC for ${CHAIN_CONFIG.nativeSymbol}" or "Claim my rewards".`,
        requiresConfirmation: false,
      };
    }

    // 4. Get solver
    log.debug({ choice: "solver-lookup", action: intent.action }, "looking up solver");
    const solver = await this.solverRegistry.getSolverAsync(intent.action);
    log.debug({ choice: "solver-result", action: intent.action, found: !!solver }, "solver resolved");
    if (!solver) {
      await this.intentDB.create({
        id: intentId,
        userId: params.userId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        rawInput: params.rawInput,
        parsedJson: JSON.stringify(intent),
        status: INTENT_STATUSES.REJECTED,
        rejectionReason: `No solver for action: ${intent.action}`,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });
      return {
        intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: `This action (${intent.action}) is not yet supported. Supported actions: swap, claim_rewards.`,
        requiresConfirmation: false,
      };
    }

    // 5. Get user's address (EOA from profile if available)
    const profile = await this.userProfileDB.findByUserId(params.userId);
    const userAddress = profile?.eoaAddress ?? "";

    // 6. Build calldata
    log.debug({ choice: "build-calldata", userAddress }, "building calldata");
    let calldata: { to: string; data: string; value: string };
    try {
      calldata = await solver.buildCalldata(intent, userAddress);
      log.info({ step: "calldata-built", to: calldata.to, value: calldata.value, dataLen: calldata.data.length }, "calldata built");
    } catch (err) {
      const reason = toErrorMessage(err);
      await this.intentDB.create({
        id: intentId,
        userId: params.userId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        rawInput: params.rawInput,
        parsedJson: JSON.stringify(intent),
        status: INTENT_STATUSES.REJECTED,
        rejectionReason: reason,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });
      return {
        intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: `Couldn't build transaction: ${reason}`,
        requiresConfirmation: false,
      };
    }

    // 7. Save intent record
    await this.intentDB.create({
      id: intentId,
      userId: params.userId,
      conversationId: params.conversationId,
      messageId: params.messageId,
      rawInput: params.rawInput,
      parsedJson: JSON.stringify(intent),
      status: INTENT_STATUSES.AWAITING_CONFIRMATION,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });

    const humanSummary = this.buildCalldataSummary(intent, calldata);
    return {
      intentId,
      status: INTENT_STATUSES.AWAITING_CONFIRMATION,
      calldata,
      humanSummary,
      requiresConfirmation: false,
    };
  }

  async searchTokens(symbol: string, chainId: number): Promise<ITokenRecord[]> {
    return this.tokenRegistryService.searchBySymbol(symbol, chainId);
  }

  async classifyIntent(messages: string[]): Promise<USER_INTENT_TYPE> {
    return this.intentClassifier.classify(messages);
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

  private buildCalldataSummary(
    intent: IntentPackage,
    calldata: { to: string; data: string; value: string },
  ): string {
    const lines: string[] = ["⚡ Transaction Ready", ""];

    const actionLabel: Record<string, string> = {
      [INTENT_ACTION.SWAP]: "Swap",
      [INTENT_ACTION.STAKE]: "Stake",
      [INTENT_ACTION.UNSTAKE]: "Unstake",
      [INTENT_ACTION.CLAIM_REWARDS]: "Claim Rewards",
      [INTENT_ACTION.TRANSFER]: "Transfer",
      [INTENT_ACTION.UNKNOWN]: "Unknown",
    };
    lines.push(`Action: ${actionLabel[intent.action] ?? intent.action}`);

    if (intent.fromTokenSymbol) {
      lines.push(`You send: ${intent.amountHuman ?? "?"} ${intent.fromTokenSymbol}`);
    }
    if (intent.toTokenSymbol) {
      lines.push(`You receive: ~? ${intent.toTokenSymbol} (est.)`);
    }

    lines.push(`Contract: ${calldata.to}`);
    lines.push(`Value: ${calldata.value}`);
    lines.push("");
    lines.push("Open the Aegis app to sign and execute this transaction.");

    return lines.join("\n");
  }
}
