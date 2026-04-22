import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { toErrorMessage } from "../../helpers/errors/toErrorMessage";
import { CHAIN_CONFIG } from "../../helpers/chainConfig";
import { extractAddressFields } from "../../helpers/schema/addressFields";
import { newUuid } from "../../helpers/uuid";
import { INTENT_STATUSES } from "../../helpers/enums/intentStatus.enum";
import { EXECUTION_STATUSES } from "../../helpers/enums/executionStatus.enum";
import { INTENT_ACTION } from "../../helpers/enums/intentAction.enum";
import { USER_INTENT_TYPE } from "../../helpers/enums/userIntentType.enum";
import { toRaw } from "../../helpers/bigint";
import type {
  IIntentUseCase,
  IntentExecutionResult,
  ParseFromHistoryResult,
  ConfirmAndExecuteParams,
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
import { validateIntent } from "../../adapters/implementations/output/intentParser/intent.validator";
import type { IToolManifestDB, IToolManifestRecord } from "../interface/output/repository/toolManifest.repo";
import type { IToolIndexService } from "../interface/output/toolIndex.interface";
import { deserializeManifest, type ToolManifest } from "../interface/output/toolManifest.types";
import type { IIntentClassifier } from "../interface/output/intentClassifier.interface";
import type { ISchemaCompiler, CompileResult } from "../interface/output/schemaCompiler.interface";
import type { ICommandToolMappingDB } from "../interface/output/repository/commandToolMapping.repo";
import type { IIntentExecutionDB } from "../interface/output/repository/intentExecution.repo";
import type { ITokenDelegationDB } from "../interface/output/repository/tokenDelegation.repo";
import type { IUserOpExecutor } from "../interface/output/blockchain/userOpExecutor.interface";

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
    private readonly intentExecutionDB?: IIntentExecutionDB,
    private readonly tokenDelegationDB?: ITokenDelegationDB,
    private readonly userOpExecutor?: IUserOpExecutor,
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
    console.log(`[IntentUseCase] parseAndExecute userId=${params.userId} input="${params.rawInput.slice(0, 80)}"`);
    const relevantManifests = await this.discoverRelevantTools(params.rawInput);

    let intent: IntentPackage | null;
    try {
      console.log(`[IntentUseCase] calling intentParser with ${messages.length} messages and ${relevantManifests.length} manifests`);
      intent = await this.intentParser.parse(messages, params.userId, relevantManifests);
      console.log(`[IntentUseCase] intentParser result: ${intent === null ? "null" : `action=${intent.action} confidence=${intent.confidence}`}`);

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
    console.log(`[IntentUseCase] confidence check: ${intent.confidence} (threshold ${CONFIDENCE_THRESHOLD}) action=${intent.action}`);
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
    console.log(`[IntentUseCase] looking up solver for action="${intent.action}"`);
    const solver = await this.solverRegistry.getSolverAsync(intent.action);
    console.log(`[IntentUseCase] solver: ${solver ? solver.name : "none found"}`);
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
    console.log(`[IntentUseCase] building calldata userAddress=${userAddress}`);
    let calldata: { to: string; data: string; value: string };
    try {
      calldata = await solver.buildCalldata(intent, userAddress);
      console.log(`[IntentUseCase] calldata built to=${calldata.to} value=${calldata.value} dataLen=${calldata.data.length}`);
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

  async confirmAndExecute(
    params: ConfirmAndExecuteParams,
  ): Promise<IntentExecutionResult & { txHash?: string }> {
    const { intentId, userId, calldata, tokenAddress, amountRaw } = params;
    const now = newCurrentUTCEpoch();

    // 2. Fetch user profile — need smartAccountAddress for the UserOp.
    const profile = await this.userProfileDB.findByUserId(userId);
    const smartAccountAddress = profile?.smartAccountAddress ?? null;
    const sessionKeyAddress = profile?.sessionKeyAddress ?? null;

    if (!smartAccountAddress) {
      return {
        intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: "No smart account found for this user. Please complete onboarding first.",
        requiresConfirmation: false,
      };
    }

    if (!calldata) {
      return {
        intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: "No calldata provided for execution.",
        requiresConfirmation: false,
      };
    }

    // 3. Validate BOT_PRIVATE_KEY is configured.
    const botPrivateKey = process.env.BOT_PRIVATE_KEY;
    if (!botPrivateKey) {
      console.error("[confirmAndExecute] BOT_PRIVATE_KEY not configured");
      return {
        intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: "Bot signing key not configured — transaction cannot proceed automatically.",
        requiresConfirmation: false,
      };
    }

    let userOpHash: string | undefined;
    let txHash: string | undefined;
    let executionError: string | undefined;

    try {
      if (!this.userOpExecutor) {
        throw new Error('Autonomous execution not available — bot executor not configured');
      }

      console.log(
        `[confirmAndExecute] submitting UserOp intent=${intentId} sa=${smartAccountAddress} ` +
        `to=${calldata.to} value=${calldata.value} dataLen=${calldata.data.length}`,
      );

      const result = await this.userOpExecutor.execute({
        smartAccountAddress: smartAccountAddress as `0x${string}`,
        to: calldata.to as `0x${string}`,
        data: calldata.data as `0x${string}`,
        value: calldata.value,
      });

      userOpHash = result.userOpHash;
      txHash = result.txHash;

      console.log(`[confirmAndExecute] UserOp confirmed userOpHash=${userOpHash} txHash=${txHash}`);
    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err);
      console.error(`[confirmAndExecute] UserOp submission failed:`, err);
    }

    const finalStatus = executionError
      ? INTENT_STATUSES.REJECTED
      : INTENT_STATUSES.CONFIRMED;
    const execStatus = executionError
      ? EXECUTION_STATUSES.FAILED
      : EXECUTION_STATUSES.SUBMITTED;

    // 7. Save intent_executions row (create then update with hashes).
    if (this.intentExecutionDB) {
      const executionId = newUuid();
      await this.intentExecutionDB.create({
        id: executionId,
        intentId,
        userId,
        smartAccountAddress,
        solverUsed: "session_key_bot",
        simulationPassed: !executionError,
        simulationResult: executionError ?? null,
        status: execStatus,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      }).catch((e) => console.error("[confirmAndExecute] save execution row failed:", e));

      if (userOpHash || txHash || executionError) {
        await this.intentExecutionDB.update(executionId, {
          userOpHash: userOpHash ?? null,
          txHash: txHash ?? null,
          errorMessage: executionError ?? null,
        }).catch((e) => console.error("[confirmAndExecute] update execution row failed:", e));
      }
    }

    // 8. Update intent status.
    await this.intentDB
      .updateStatus(intentId, finalStatus)
      .catch((e) => console.error("[confirmAndExecute] updateStatus failed:", e));

    // 9. Record spent amount for the delegation capacity tracker.
    if (!executionError && tokenAddress && amountRaw && this.tokenDelegationDB) {
      await this.tokenDelegationDB
        .addSpent(userId, tokenAddress, amountRaw)
        .catch((e) => console.error("[confirmAndExecute] addSpent failed:", e));
    }

    if (executionError) {
      return {
        intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: `Transaction failed: ${executionError}`,
        requiresConfirmation: false,
        txHash,
      };
    }

    // 10. Build human-readable result.
    const humanSummary = txHash
      ? `✅ Transaction submitted!\nTx: \`${txHash}\``
      : `✅ Transaction queued (userOpHash: \`${userOpHash}\`). Confirmation pending.`;

    return {
      intentId,
      status: INTENT_STATUSES.CONFIRMED,
      humanSummary,
      requiresConfirmation: false,
      txHash,
    };
  }

  async getHistory(userId: string): Promise<IntentPackage[]> {
    const intents = await this.intentDB.listByUserId(userId, 20);
    return intents.map((i) => {
      try {
        return JSON.parse(i.parsedJson) as IntentPackage;
      } catch {
        return {
          action: INTENT_ACTION.UNKNOWN,
          confidence: 0,
          rawInput: i.rawInput,
        };
      }
    });
  }

  async parseFromHistory(messages: string[], userId: string): Promise<ParseFromHistoryResult> {
    const query = messages[0] ?? '';
    const relevantManifests = await this.discoverRelevantTools(query);
    const intent = await this.intentParser.parse(messages, userId, relevantManifests);
    if (intent === null) return { intent: null, manifest: undefined };
    const manifest = relevantManifests.find((m) => m.toolId === intent.action);
    validateIntent(intent, messages.length, manifest);
    return { intent, manifest };
  }

  async searchTokens(symbol: string, chainId: number): Promise<ITokenRecord[]> {
    return this.tokenRegistryService.searchBySymbol(symbol, chainId);
  }

  async previewCalldata(
    intent: IntentPackage,
    manifest: ToolManifest,
  ): Promise<{ to: string; data: string; value: string } | null> {
    return this.solverRegistry.buildFromManifest(manifest, intent, '');
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
          console.log(
            `[IntentUseCase] selectTool → explicit mapping: command="${bareCommand}" → toolId="${mapping.toolId}"`,
          );
          return { toolId: record.toolId, manifest: deserializeManifest(record) };
        }
        console.log(
          `[IntentUseCase] selectTool: explicit mapping exists for "${bareCommand}" but tool "${mapping.toolId}" is inactive/missing — falling back to RAG`,
        );
      }
    }

    // 2. Fallback: existing RAG / ILIKE discovery.
    const query = `${intentType} ${messages.join(" ")}`;
    const manifests = await this.discoverRelevantTools(query);
    if (manifests.length === 0) return null;
    const top = manifests[0]!;
    console.log(`[IntentUseCase] selectTool → RAG: ${top.toolId} (${manifests.length} candidates)`);
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
        console.log(`[IntentUseCase] vector search query="${rawInput.slice(0, 80)}" chainId=${this.chainId}`);
        const hits = await this.toolIndexService.search(rawInput, {
          topK: 20,
          chainId: this.chainId,
          minScore: 0.3,
        });
        console.log(`[IntentUseCase] vector search returned ${hits.length} hits: [${hits.map((h) => `${h.toolId}(${h.score.toFixed(2)})`).join(", ")}]`);

        if (hits.length > 0) {
          const toolIds = hits.map((h) => h.toolId);
          const records = await this.toolManifestDB.findByToolIds(toolIds);
          console.log(`[IntentUseCase] loaded ${records.length} manifests from DB for vector hits`);

          const scoreMap = new Map(hits.map((h) => [h.toolId, h.score]));
          records.sort((a, b) => (scoreMap.get(b.toolId) ?? 0) - (scoreMap.get(a.toolId) ?? 0));

          const resolved = this.resolveConflicts(records, rawInput);
          console.log(`[IntentUseCase] resolved tools (vector): [${resolved.map((t) => t.toolId).join(", ")}]`);
          return resolved;
        }

        console.log(`[IntentUseCase] vector search: 0 results above threshold, returning empty`);
        return [];
      } catch (err) {
        console.error("[IntentUseCase] vector search failed, falling back to ILIKE:", err);
      }
    } else {
      console.log(`[IntentUseCase] no toolIndexService configured, using ILIKE fallback`);
    }

    const candidates = await this.toolManifestDB.search(rawInput, {
      limit: 15,
      chainId: this.chainId,
    });
    console.log(`[IntentUseCase] ILIKE fallback returned ${candidates.length} candidates: [${candidates.map((c) => c.toolId).join(", ")}]`);
    const resolved = this.resolveConflicts(candidates, rawInput);
    console.log(`[IntentUseCase] resolved tools (ILIKE): [${resolved.map((t) => t.toolId).join(", ")}]`);
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
