import { toRaw } from "../../../../helpers/bigint";
import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import { RESOLVER_FIELD } from "../../../../helpers/enums/resolverField.enum";
import { USER_INTENT_TYPE } from "../../../../helpers/enums/userIntentType.enum";
import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type { IIntentUseCase } from "../../../../use-cases/interface/input/intent.interface";
import {
  type ITokenRecord,
  type ResolvedPayload,
  type ToolManifest,
  DisambiguationRequiredError,
} from "../../../../use-cases/interface/input/intent.interface";
import type { IResolverEngine } from "../../../../use-cases/interface/output/resolver.interface";
import type { IExecutionEstimator } from "../../../../use-cases/interface/output/executionEstimator.interface";
import type { ITokenDelegationDB } from "../../../../use-cases/interface/output/repository/tokenDelegation.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { IPendingDelegationDB } from "../../../../use-cases/interface/output/repository/pendingDelegation.repo";
import type { IDelegationRequestBuilder } from "../../../../use-cases/interface/output/delegation/delegationRequestBuilder.interface";
import type { ITelegramHandleResolver } from "../../../../use-cases/interface/output/telegramResolver.interface";
import { TelegramHandleNotFoundError } from "../../../../use-cases/interface/output/telegramResolver.interface";
import type { IPrivyAuthService } from "../../../../use-cases/interface/output/privyAuth.interface";
import { checkTokenDelegation } from "../../../../use-cases/implementations/aegisGuardInterceptor";
import {
  buildConfirmationMessage,
  buildDelegationPrompt,
  buildDisambiguationPrompt,
  buildFinalSchemaConfirmation,
  populateFinalSchema,
} from "./send.messages";
import {
  detectStablecoinIntent,
  getMissingRequiredFields,
  pickCandidateByInput,
} from "./send.utils";

const DEFAULT_MAX_COMPILE_TURNS = 10;
const MAX_COMPILE_TURNS = parseInt(
  process.env.MAX_TOOL_ROUNDS ?? String(DEFAULT_MAX_COMPILE_TURNS),
  10,
);
const MAX_DISAMBIG_TURNS = 10;

interface DisambiguationState {
  resolvedFrom: ITokenRecord | null;
  resolvedTo: ITokenRecord | null;
  awaitingSlot: "from" | "to";
  fromCandidates: ITokenRecord[];
  toCandidates: ITokenRecord[];
}

interface SessionState {
  stage: "compile" | "token_disambig";
  messages: string[];
  manifest: ToolManifest;
  partialParams: Record<string, unknown>;
  tokenSymbols: { from?: string; to?: string };
  resolverFields: Partial<Record<string, string>>;
  compileTurns: number;
  disambigTurns: number;
  resolved?: ResolvedPayload;
  disambiguation?: DisambiguationState;
  recipientTelegramUserId?: string;
}

interface SendParams {
  manifest: ToolManifest;
  partialParams: Record<string, unknown>;
  resolved?: ResolvedPayload;
  resolvedFrom: ITokenRecord | null;
  resolvedTo: ITokenRecord | null;
  recipientTelegramUserId?: string;
  usesDualSchema: boolean;
}

export interface SendCapabilityDeps {
  intentUseCase: IIntentUseCase;
  resolverEngine?: IResolverEngine;
  tokenDelegationDB?: ITokenDelegationDB;
  executionEstimator?: IExecutionEstimator;
  telegramHandleResolver?: ITelegramHandleResolver;
  privyAuthService?: IPrivyAuthService;
  userProfileRepo?: IUserProfileDB;
  pendingDelegationRepo?: IPendingDelegationDB;
  delegationBuilder?: IDelegationRequestBuilder;
  chainId: number;
}

/**
 * Generic intent-command capability. One instance per INTENT_COMMAND
 * (/send, /convert, /sell, etc.) — each registers with its own trigger and
 * shares the compile → resolve → confirm pipeline.
 *
 * This is a line-for-line port of the pipeline that used to live in
 * adapters/implementations/input/telegram/handler.ts. No behavior change;
 * the multi-turn state (previously `orchestratorSessions` per-chat map)
 * now lives inside the dispatcher's pending-collection store.
 */
export class SendCapability implements Capability<SendParams> {
  readonly id: string;
  readonly triggers: TriggerSpec;

  constructor(
    private readonly command: INTENT_COMMAND,
    private readonly deps: SendCapabilityDeps,
  ) {
    this.id = `intent_${command.replace("/", "")}`;
    this.triggers = { command };
  }

  async collect(
    ctx: CapabilityCtx,
    resuming?: Record<string, unknown>,
  ): Promise<CollectResult<SendParams>> {
    if (ctx.input.kind !== "text") {
      return this.abort("Unexpected input.");
    }
    const text = ctx.input.text;

    if (resuming) {
      const state = resuming as unknown as SessionState;
      if (state.stage === "token_disambig") {
        return this.handleDisambiguationReply(ctx, text, state);
      }
      if (state.stage === "compile") {
        state.messages.push(text);
        return this.continueCompileLoop(ctx, state);
      }
      return this.abort("Session error. Please start over.");
    }

    // Fresh entry.
    const toolResult = await this.deps.intentUseCase.selectTool(
      this.command as unknown as USER_INTENT_TYPE,
      [text],
    );
    if (!toolResult) {
      return this.abort(`No tool is registered for ${this.command}. Contact the admin.`);
    }

    console.log(
      `[SendCapability] command=${this.command} → tool=${toolResult.toolId}, compiling schema…`,
    );
    return this.initSessionFromTool(ctx, text, toolResult);
  }

  async run(params: SendParams, ctx: CapabilityCtx): Promise<Artifact> {
    let calldata: { to: string; data: string; value: string };
    try {
      calldata = await this.deps.intentUseCase.buildRequestBody({
        manifest: params.manifest,
        params: params.partialParams,
        resolvedFrom: params.resolvedFrom,
        resolvedTo: params.resolvedTo,
        userId: ctx.userId,
        amountHuman: params.partialParams.amountHuman as string | undefined,
      });
    } catch (err) {
      console.error("[SendCapability] buildRequestBody failed:", err);
      return {
        kind: "chat",
        text: `Could not build transaction: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const fromToken = params.resolvedFrom;

    console.log("[SendCapability] autosign guard", {
      hasFromToken: !!fromToken,
      isNative: fromToken?.isNative,
      symbol: fromToken?.symbol,
      address: fromToken?.address,
      hasTokenDelegationDB: !!this.deps.tokenDelegationDB,
      hasExecutionEstimator: !!this.deps.executionEstimator,
      usesDualSchema: params.usesDualSchema,
    });

    // Auto-sign path: delegation already sufficient.
    if (
      fromToken &&
      !fromToken.isNative &&
      this.deps.tokenDelegationDB &&
      this.deps.executionEstimator
    ) {
      const guard = await checkTokenDelegation({
        userId: ctx.userId,
        fromToken,
        amountHuman: (params.partialParams.amountHuman as string) ?? "0",
        amountRaw: (params.partialParams.amountRaw as string) ?? "0",
        tokenDelegationDB: this.deps.tokenDelegationDB,
        executionEstimator: this.deps.executionEstimator,
      });
      if (guard.ok) {
        console.log(
          `[SendCapability] delegation sufficient — pushing auto-sign request to Mini App for userId=${ctx.userId}`,
        );
        await ctx.emit({
          kind: "chat",
          text: "✅ Check the Aegis mini app to complete the transaction automatically.",
          parseMode: "Markdown",
        });
        await ctx.emit({
          kind: "sign_calldata",
          to: calldata.to,
          data: calldata.data,
          value: calldata.value,
          description: `Autonomous execution for ${params.manifest.name}`,
          autoSign: true,
        });
        await this.tryEmitDelegationRequest(ctx, params, fromToken);
        return { kind: "noop" };
      }

      return {
        kind: "mini_app",
        request: guard.reapprovalRequest,
        promptText: guard.displayMessage,
        buttonText: "Approve More",
      };
    }

    // Confirmation path.
    if (params.manifest.finalSchema && params.resolved) {
      const filled = populateFinalSchema(
        params.manifest.finalSchema,
        params.resolved,
        params.partialParams,
      );
      await ctx.emit({
        kind: "chat",
        text: buildFinalSchemaConfirmation(
          { manifest: params.manifest, partialParams: params.partialParams },
          filled,
          calldata,
        ),
        parseMode: "Markdown",
      });
    } else {
      await ctx.emit({
        kind: "chat",
        text: buildConfirmationMessage(
          { manifest: params.manifest, partialParams: params.partialParams },
          calldata,
          params.resolvedFrom,
          params.resolvedTo,
        ),
        parseMode: "Markdown",
      });
    }

    await ctx.emit({
      kind: "sign_calldata",
      to: calldata.to,
      data: calldata.data,
      value: calldata.value,
      description: params.manifest.name,
      autoSign: false,
    });

    await this.tryEmitDelegationRequest(ctx, params, params.resolvedFrom);
    return { kind: "noop" };
  }

  // ── Phase 1 / fresh session ───────────────────────────────────────────────

  private async initSessionFromTool(
    ctx: CapabilityCtx,
    text: string,
    toolResult: { toolId: string; manifest: ToolManifest },
  ): Promise<CollectResult<SendParams>> {
    const compileResult = await this.deps.intentUseCase.compileSchema({
      manifest: toolResult.manifest,
      messages: [text],
      userId: ctx.userId,
      partialParams: {},
    });

    if (
      detectStablecoinIntent(text) &&
      !compileResult.resolverFields?.[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] &&
      !compileResult.tokenSymbols?.from
    ) {
      compileResult.resolverFields = {
        ...compileResult.resolverFields,
        [RESOLVER_FIELD.FROM_TOKEN_SYMBOL]: "USDC",
      };
      compileResult.tokenSymbols = { ...compileResult.tokenSymbols, from: "USDC" };
    }

    const state: SessionState = {
      stage: "compile",
      messages: [text],
      manifest: toolResult.manifest,
      partialParams: compileResult.params,
      tokenSymbols: compileResult.tokenSymbols,
      resolverFields: compileResult.resolverFields ?? {},
      compileTurns: 1,
      disambigTurns: 0,
    };

    if (compileResult.telegramHandle && !state.recipientTelegramUserId) {
      const ok = await this.resolveRecipientHandle(ctx, compileResult.telegramHandle, state);
      // resolveRecipientHandle has already emitted the specific user-facing
      // error message via ctx.emit — abort silently to avoid a duplicate.
      if (!ok) return this.silentAbort();
    }

    if (compileResult.missingQuestion) {
      return { kind: "ask", question: compileResult.missingQuestion, state: toPlain(state) };
    }

    return this.finishCompileOrResolve(ctx, state);
  }

  // ── Phase 2 / continue compile ────────────────────────────────────────────

  private async continueCompileLoop(
    ctx: CapabilityCtx,
    state: SessionState,
  ): Promise<CollectResult<SendParams>> {
    if (state.compileTurns >= MAX_COMPILE_TURNS) {
      return this.abort(
        "I couldn't collect all required information after several attempts. Please start over with a new request.",
      );
    }
    state.compileTurns += 1;

    const compileResult = await this.deps.intentUseCase.compileSchema({
      manifest: state.manifest,
      messages: state.messages,
      userId: ctx.userId,
      partialParams: state.partialParams,
    });

    const anyFiatMessage = state.messages.some(detectStablecoinIntent);
    if (
      anyFiatMessage &&
      !compileResult.resolverFields?.[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] &&
      !state.resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] &&
      !compileResult.tokenSymbols?.from &&
      !state.tokenSymbols.from
    ) {
      compileResult.resolverFields = {
        ...compileResult.resolverFields,
        [RESOLVER_FIELD.FROM_TOKEN_SYMBOL]: "USDC",
      };
      compileResult.tokenSymbols = { ...compileResult.tokenSymbols, from: "USDC" };
    }

    state.partialParams = { ...state.partialParams, ...compileResult.params };
    state.tokenSymbols = { ...state.tokenSymbols, ...compileResult.tokenSymbols };
    state.resolverFields = { ...state.resolverFields, ...(compileResult.resolverFields ?? {}) };

    if (compileResult.telegramHandle && !state.recipientTelegramUserId) {
      const ok = await this.resolveRecipientHandle(ctx, compileResult.telegramHandle, state);
      // resolveRecipientHandle has already emitted the specific user-facing
      // error message via ctx.emit — abort silently to avoid a duplicate.
      if (!ok) return this.silentAbort();
    }

    if (compileResult.missingQuestion) {
      return { kind: "ask", question: compileResult.missingQuestion, state: toPlain(state) };
    }

    return this.finishCompileOrResolve(ctx, state);
  }

  // ── Phase 2 → 3 transition ────────────────────────────────────────────────

  private async finishCompileOrResolve(
    ctx: CapabilityCtx,
    state: SessionState,
  ): Promise<CollectResult<SendParams>> {
    const missing = getMissingRequiredFields(state.manifest, state.partialParams);
    if (missing.length > 0) {
      const question = await this.deps.intentUseCase.generateMissingParamQuestion(
        state.manifest,
        missing,
      );
      return { kind: "ask", question, state: toPlain(state) };
    }

    const usesDualSchema = this.usesDualSchema(state.manifest);
    if (usesDualSchema) {
      return this.runResolutionPhase(ctx, state);
    }
    return this.resolveTokensAndFinish(ctx, state);
  }

  // ── Phase 3 — dual-schema resolver path ───────────────────────────────────

  private async runResolutionPhase(
    ctx: CapabilityCtx,
    state: SessionState,
  ): Promise<CollectResult<SendParams>> {
    try {
      const resolved = await this.deps.resolverEngine!.resolve({
        resolverFields: state.resolverFields,
        userId: ctx.userId,
        chainId: this.deps.chainId,
      });
      state.resolved = resolved;
      if (resolved.recipientTelegramUserId) {
        state.recipientTelegramUserId = resolved.recipientTelegramUserId;
      }
      if (resolved.rawAmount) state.partialParams.amountRaw = resolved.rawAmount;
      if (resolved.recipientAddress) state.partialParams.recipient = resolved.recipientAddress;
      if (resolved.senderAddress) state.partialParams.userAddress = resolved.senderAddress;

      return {
        kind: "ok",
        params: {
          manifest: state.manifest,
          partialParams: state.partialParams,
          resolved,
          resolvedFrom: resolved.fromToken,
          resolvedTo: resolved.toToken,
          recipientTelegramUserId: state.recipientTelegramUserId,
          usesDualSchema: true,
        },
      };
    } catch (err) {
      if (err instanceof DisambiguationRequiredError) {
        return this.enterDisambiguationFromResolver(state, err);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return this.abort(`Could not resolve transaction details: ${msg}`);
    }
  }

  private enterDisambiguationFromResolver(
    state: SessionState,
    err: DisambiguationRequiredError,
  ): CollectResult<SendParams> {
    state.stage = "token_disambig";
    state.disambiguation = {
      resolvedFrom: err.slot === "to" ? state.resolved?.fromToken ?? null : null,
      resolvedTo: err.slot === "from" ? state.resolved?.toToken ?? null : null,
      awaitingSlot: err.slot,
      fromCandidates: err.slot === "from" ? err.candidates : [],
      toCandidates: err.slot === "to" ? err.candidates : [],
    };
    return {
      kind: "ask",
      question: buildDisambiguationPrompt(err.slot, err.symbol, err.candidates),
      state: toPlain(state),
    };
  }

  // ── Phase 3 — disambiguation reply ────────────────────────────────────────

  private async handleDisambiguationReply(
    ctx: CapabilityCtx,
    text: string,
    state: SessionState,
  ): Promise<CollectResult<SendParams>> {
    const pending = state.disambiguation;
    if (!pending) return this.abort("Session error. Please start over.");

    state.disambigTurns += 1;
    if (state.disambigTurns > MAX_DISAMBIG_TURNS) {
      return this.abort("Token selection timed out after too many attempts. Please start over.");
    }

    const candidates =
      pending.awaitingSlot === "from" ? pending.fromCandidates : pending.toCandidates;
    const selected = pickCandidateByInput(text, candidates);
    if (!selected) return this.abort("Disambiguation cancelled. Please repeat your request.");

    const usesDualSchema = this.usesDualSchema(state.manifest);

    if (pending.awaitingSlot === "from") {
      pending.resolvedFrom = selected;
      if (usesDualSchema) state.resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] = selected.address;
      if (pending.toCandidates.length > 1) {
        pending.awaitingSlot = "to";
        return {
          kind: "ask",
          question: buildDisambiguationPrompt("to", state.tokenSymbols.to ?? "", pending.toCandidates),
          state: toPlain(state),
        };
      }
      pending.resolvedTo = pending.toCandidates[0] ?? null;
    } else {
      pending.resolvedTo = selected;
      if (usesDualSchema) state.resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL] = selected.address;
    }

    state.disambiguation = undefined;
    state.stage = "compile";

    if (usesDualSchema) return this.runResolutionPhase(ctx, state);

    return {
      kind: "ok",
      params: {
        manifest: state.manifest,
        partialParams: state.partialParams,
        resolvedFrom: pending.resolvedFrom,
        resolvedTo: pending.resolvedTo,
        recipientTelegramUserId: state.recipientTelegramUserId,
        usesDualSchema: false,
      },
    };
  }

  // ── Phase 3 — legacy single-schema token resolution ───────────────────────

  private async resolveTokensAndFinish(
    ctx: CapabilityCtx,
    state: SessionState,
  ): Promise<CollectResult<SendParams>> {
    const chainId = this.deps.chainId;
    let fromCandidates: ITokenRecord[] = [];
    let toCandidates: ITokenRecord[] = [];

    if (state.tokenSymbols.from) {
      fromCandidates = await this.deps.intentUseCase.searchTokens(state.tokenSymbols.from, chainId);
      if (fromCandidates.length === 0) {
        return this.abort(
          `Token not found: ${state.tokenSymbols.from}. Make sure it is supported on this chain.`,
        );
      }
    }
    if (state.tokenSymbols.to) {
      toCandidates = await this.deps.intentUseCase.searchTokens(state.tokenSymbols.to, chainId);
      if (toCandidates.length === 0) {
        return this.abort(
          `Token not found: ${state.tokenSymbols.to}. Make sure it is supported on this chain.`,
        );
      }
    }

    const resolvedFrom = fromCandidates.length === 1 ? fromCandidates[0]! : null;
    const resolvedTo = toCandidates.length === 1 ? toCandidates[0]! : null;

    if (fromCandidates.length > 1) {
      state.stage = "token_disambig";
      state.disambiguation = {
        resolvedFrom: null,
        resolvedTo: null,
        awaitingSlot: "from",
        fromCandidates,
        toCandidates,
      };
      return {
        kind: "ask",
        question: buildDisambiguationPrompt("from", state.tokenSymbols.from!, fromCandidates),
        state: toPlain(state),
      };
    }

    if (toCandidates.length > 1) {
      state.stage = "token_disambig";
      state.disambiguation = {
        resolvedFrom,
        resolvedTo: null,
        awaitingSlot: "to",
        fromCandidates,
        toCandidates,
      };
      return {
        kind: "ask",
        question: buildDisambiguationPrompt("to", state.tokenSymbols.to!, toCandidates),
        state: toPlain(state),
      };
    }

    return {
      kind: "ok",
      params: {
        manifest: state.manifest,
        partialParams: state.partialParams,
        resolvedFrom,
        resolvedTo,
        recipientTelegramUserId: state.recipientTelegramUserId,
        usesDualSchema: false,
      },
    };
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  private usesDualSchema(manifest: ToolManifest): boolean {
    return (
      manifest.requiredFields !== undefined &&
      Object.keys(manifest.requiredFields).length > 0 &&
      this.deps.resolverEngine !== undefined
    );
  }

  private async resolveRecipientHandle(
    ctx: CapabilityCtx,
    handle: string,
    state: SessionState,
  ): Promise<boolean> {
    if (!this.deps.telegramHandleResolver || !this.deps.privyAuthService) {
      await ctx.emit({
        kind: "chat",
        text: "Sorry, peer-to-peer transfers are not configured on this server.",
      });
      return false;
    }

    await ctx.emit({ kind: "chat", text: `Resolving @${handle}...` });
    let telegramUserId: string;
    try {
      telegramUserId = await this.deps.telegramHandleResolver.resolveHandle(handle);
      await ctx.emit({
        kind: "chat",
        text: `@${handle} → Telegram ID: \`${telegramUserId}\``,
        parseMode: "Markdown",
      });
    } catch (err) {
      const isNotFound = err instanceof TelegramHandleNotFoundError;
      const msg = isNotFound
        ? `Sorry, I couldn't find a Telegram user for @${handle}. Double-check the handle and try again.`
        : `Sorry, something went wrong resolving @${handle}. Please try again.`;
      if (!isNotFound) console.error(`[SendCapability] resolveHandle error for @${handle}:`, err);
      await ctx.emit({ kind: "chat", text: msg });
      return false;
    }

    await ctx.emit({
      kind: "chat",
      text: `Finding wallet for Telegram user \`${telegramUserId}\`...`,
      parseMode: "Markdown",
    });
    let recipientAddress: string;
    try {
      recipientAddress = await this.deps.privyAuthService.getOrCreateWalletByTelegramId(telegramUserId);
      await ctx.emit({
        kind: "chat",
        text: `Recipient wallet: \`${recipientAddress}\``,
        parseMode: "Markdown",
      });
    } catch (err) {
      console.error(
        `[SendCapability] Privy wallet resolution failed for telegramUserId=${telegramUserId}:`,
        err,
      );
      await ctx.emit({
        kind: "chat",
        text: `Sorry, I couldn't set up a wallet for @${handle}. Please try again later.`,
      });
      return false;
    }

    state.partialParams.recipient = recipientAddress;
    state.recipientTelegramUserId = telegramUserId;
    return true;
  }

  private async tryEmitDelegationRequest(
    ctx: CapabilityCtx,
    params: SendParams,
    resolvedFrom: ITokenRecord | null,
  ): Promise<void> {
    if (
      !this.deps.delegationBuilder ||
      !this.deps.pendingDelegationRepo ||
      !this.deps.userProfileRepo ||
      !resolvedFrom ||
      resolvedFrom.isNative ||
      !params.partialParams.amountHuman
    ) {
      return;
    }
    try {
      const profile = await this.deps.userProfileRepo.findByUserId(ctx.userId);
      if (!profile?.sessionKeyAddress) return;
      const amountRaw = toRaw(params.partialParams.amountHuman as string, resolvedFrom.decimals);
      const delegationMsg = this.deps.delegationBuilder.buildErc20Spend({
        sessionKeyAddress: profile.sessionKeyAddress,
        target: resolvedFrom.address,
        valueLimit: amountRaw,
        chainId: this.deps.chainId,
      });
      await this.deps.pendingDelegationRepo.create({ userId: ctx.userId, zerodevMessage: delegationMsg });
      await ctx.emit({
        kind: "chat",
        text: buildDelegationPrompt(delegationMsg),
        parseMode: "Markdown",
      });
    } catch (err) {
      console.error("[SendCapability] delegation request error:", err);
    }
  }

  private silentAbort(): CollectResult<SendParams> {
    return { kind: "terminal", artifact: { kind: "noop" } };
  }

  private abort(message: string): CollectResult<SendParams> {
    return { kind: "terminal", artifact: { kind: "chat", text: message } };
  }
}

/**
 * `toPlain` makes sure the state we persist through the PendingCollection
 * store is a plain JSON-serialisable object. ToolManifest instances are
 * already plain, but this guards against accidental class instances
 * creeping in.
 */
function toPlain(state: SessionState): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
}
