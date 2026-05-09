import { toRaw } from "../../../../helpers/bigint";
import {
  RELAY_SUPPORTED_CHAIN_IDS,
  getUsdcAddress,
  resolveChainSymbol,
} from "../../../../helpers/chainConfig";
import { interpretError } from "../../../../helpers/errors/errorCatalog";
import type { IntentResult } from "../../../../use-cases/interface/input/resultCard.types";
import { buildPreview } from "./buildPreview";
import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import { RESOLVER_FIELD } from "../../../../helpers/enums/resolverField.enum";
import { TOOL_CATEGORY } from "../../../../helpers/enums/toolCategory.enum";
import { createLogger } from "../../../../helpers/observability/logger";
import { MAX_TOOL_ROUNDS } from "../../../../helpers/env/assistantEnv";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import { checkTokenDelegation } from "../../../../use-cases/implementations/aegisGuardInterceptor";
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
  DisambiguationRequiredError,
} from "../../../../use-cases/interface/input/intent.interface";
import type { CapabilityManifest } from "../../../../helpers/types/manifest";
import type { ILoyaltyUseCase } from "../../../../use-cases/interface/input/loyalty.interface";
import type { ISigningRequestUseCase } from "../../../../use-cases/interface/input/signingRequest.interface";
import type { IMiniAppRequestCache } from "../../../../use-cases/interface/output/cache/miniAppRequest.cache";
import type { IPendingIntentStore } from "../../../../use-cases/interface/output/cache/pendingIntent.cache";
import type { SignRequest } from "../../../../use-cases/interface/output/cache/miniAppRequest.types";
import type { SigningRequestRecord } from "../../../../use-cases/interface/output/cache/signingRequest.cache";
import type { ITokenDelegationDB } from "../../../../use-cases/interface/output/repository/tokenDelegation.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { IResolverEngine } from "../../../../use-cases/interface/output/resolver.interface";
import type {
  RelaySwapTool,
  RelaySwapToolOutputData,
} from "../tools/system/relaySwap.tool";
import { buildDisambiguationPrompt } from "./send.messages";
import { getMissingRequiredFields, pickCandidateByInput } from "./send.utils";

const log = createLogger("swapCapability");

const MAX_COMPILE_TURNS = MAX_TOOL_ROUNDS;
const MAX_DISAMBIG_TURNS = 10;
const SIGN_REQUEST_TTL_SECONDS = 600;
const SIGN_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

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
  partialParams: Record<string, unknown>;
  tokenSymbols: { from?: string; to?: string };
  resolverFields: Partial<Record<string, string>>;
  compileTurns: number;
  disambigTurns: number;
  fromChainSymbol?: string;
  toChainSymbol?: string;
  disambiguation?: DisambiguationState;
}

interface SwapParams {
  fromToken: ITokenRecord;
  toToken: ITokenRecord;
  amountHuman: string;
  amountRaw: string;
  fromChainId: number;
  toChainId: number;
  userAddress: string;
  /**
   * Set when this run is a post-approval auto-resume. Quotes are time-sensitive,
   * so a resumed swap always re-fetches a fresh Relay route (the quote step in
   * `run` is unconditional today, but this flag makes the contract explicit and
   * lights up resume-path telemetry).
   */
  forceRequote?: boolean;
}

export interface SwapCapabilityDeps {
  intentUseCase: IIntentUseCase;
  resolverEngine: IResolverEngine;
  relaySwapTool: RelaySwapTool;
  signingRequestUseCase: ISigningRequestUseCase;
  miniAppRequestCache?: IMiniAppRequestCache;
  pendingIntentStore?: IPendingIntentStore;
  tokenDelegationDB?: ITokenDelegationDB;
  userProfileRepo: IUserProfileDB;
  chainId: number;
  loyaltyUseCase?: ILoyaltyUseCase;
}

/**
 * /swap capability. Gathers (tokenIn, tokenOut, amount, fromChain?, toChain?)
 * through the same compile→resolve→disambiguate loop as /send, then delegates
 * to RelaySwapTool for the quote and sequences the returned transactions
 * one-at-a-time through the mini-app session-key flow. No /confirm gate:
 * once the Aegis-Guard delegation check passes, execution is automatic.
 */
export class SwapCapability implements Capability<SwapParams> {
  readonly id = "intent_swap";
  readonly triggers: TriggerSpec = { command: INTENT_COMMAND.SWAP };

  constructor(private readonly deps: SwapCapabilityDeps) {}

  async collect(
    ctx: CapabilityCtx,
    resuming?: Record<string, unknown>,
  ): Promise<CollectResult<SwapParams>> {
    if (ctx.input.kind !== "text") return this.abort("Unexpected input.");
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

    return this.initSession(ctx, text);
  }

  async run(params: SwapParams, ctx: CapabilityCtx): Promise<Artifact> {
    log.info(
      {
        step: "started",
        userId: ctx.userId,
        fromToken: params.fromToken.symbol,
        toToken: params.toToken.symbol,
        amountHuman: params.amountHuman,
        fromChainId: params.fromChainId,
        toChainId: params.toChainId,
        userAddress: params.userAddress,
        mode: params.forceRequote ? "resumed" : "fresh",
      },
      "swap run started",
    );

    // Aegis-Guard delegation check on the origin token.
    if (
      !params.fromToken.isNative &&
      this.deps.tokenDelegationDB
    ) {
      const guard = await checkTokenDelegation({
        userId: ctx.userId,
        fromToken: params.fromToken,
        amountHuman: params.amountHuman,
        amountRaw: params.amountRaw,
        tokenDelegationDB: this.deps.tokenDelegationDB,
      });
      if (!guard.ok) {
        if (this.deps.pendingIntentStore) {
          try {
            // Persist a resume-ready snapshot. `forceRequote: true` makes the
            // post-approval run() re-fetch a fresh Relay quote.
            const resumeParams: SwapParams = { ...params, forceRequote: true };
            await this.deps.pendingIntentStore.save({
              approvalRequestId: guard.reapprovalRequest.requestId,
              capabilityId: this.id,
              params: JSON.parse(JSON.stringify(resumeParams)) as Record<string, unknown>,
              userId: ctx.userId,
              channelId: ctx.channelId,
              expiresAt: guard.reapprovalRequest.expiresAt,
            });
            log.info(
              {
                step: "approval-required",
                userId: ctx.userId,
                approvalRequestId: guard.reapprovalRequest.requestId,
              },
              "pending intent stored for post-approval resume",
            );
          } catch (err) {
            log.error(
              { err, approvalRequestId: guard.reapprovalRequest.requestId },
              "failed to persist pending intent",
            );
          }
        }
        return {
          kind: "mini_app",
          request: guard.reapprovalRequest,
          promptText: guard.displayMessage,
          buttonText: "Approve More",
        };
      }
    }

    // Fetch the Relay quote.
    const toolResult = await this.deps.relaySwapTool.execute({
      tokenIn: params.fromToken.isNative ? "native" : params.fromToken.address,
      tokenOut: params.toToken.isNative ? "native" : params.toToken.address,
      amountRaw: params.amountRaw,
      fromChainId: params.fromChainId,
      toChainId: params.toChainId,
      user: params.userAddress,
      recipient: params.userAddress,
    });

    if (!toolResult.success) {
      log.warn(
        { userId: ctx.userId, err: toolResult.error },
        "relay quote failed",
      );
      const interpreted = interpretError(toolResult.error ?? "unknown error", {
        verb: "swap",
        requestId: ctx.conversationId ?? newUuid(),
      });
      return swapFailedCard(interpreted, params);
    }
    const data = toolResult.data as RelaySwapToolOutputData;
    const txs = data.txs;
    log.info(
      {
        step: "submitted",
        userId: ctx.userId,
        txCount: txs.length,
        outputAmount: data.outputAmountFormatted ?? data.outputAmount,
      },
      "relay quote received",
    );

    // Sequence each transaction through the mini-app session-key flow. Only
    // the first step gets a Telegram button; subsequent steps are queued in
    // the mini-app cache and chained by the FE via `fetchNextRequest`, so the
    // user opens the mini app exactly once for the whole swap.
    const txHashes: string[] = [];
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i]!;
      const stepLabel =
        txs.length === 1
          ? `Relay swap`
          : `Relay swap step ${i + 1}/${txs.length}`;
      const requestId = newUuid();
      const now = newCurrentUTCEpoch();
      const chatId = Number(ctx.channelId);

      log.debug(
        {
          step: "sign-step",
          userId: ctx.userId,
          stepIndex: i,
          totalSteps: txs.length,
          requestId,
          chainId: params.fromChainId,
        },
        "awaiting step signature",
      );

      // Persist to the signing-request cache so the mini-app's
      // `POST /response` → `resolveRequest` path can match by id.
      // Attribute spend only on the final step (typically the swap call after
      // an approve) to avoid double-counting against the delegation row.
      const isLastStep = i === txs.length - 1;
      const attributesSpend = isLastStep && !params.fromToken.isNative;
      // Preview lives only on the first step's record — the mini-app modal
      // shows it once at the start of the session; subsequent steps chain
      // silently via fetchNextRequest.
      const previewForStep =
        i === 0 ? buildSwapPreview(params, data, txs.length) : undefined;
      const record: SigningRequestRecord = {
        id: requestId,
        userId: ctx.userId,
        chatId,
        to: tx.to,
        value: tx.value ?? "0",
        data: tx.data,
        description: stepLabel,
        status: "pending",
        createdAt: now,
        expiresAt: now + SIGN_REQUEST_TTL_SECONDS,
        autoSign: true,
        tokenAddress: attributesSpend
          ? params.fromToken.address.toLowerCase()
          : undefined,
        amountRaw: attributesSpend ? params.amountRaw : undefined,
        preview: previewForStep,
        // Suppress notifyResolved's generic card on intermediate steps — the
        // swap capability renders its own final card. Otherwise the user sees
        // "✅ Transaction confirmed" between approve and swap and assumes the
        // swap is already done.
        silentResolution: !isLastStep,
      };
      await this.deps.signingRequestUseCase.create(record);

      // chainId is always fromChainId — Relay steps are all on the origin chain;
      // the solver handles the destination-chain delivery without a user signature.
      const miniAppRequest: SignRequest = {
        requestId,
        requestType: "sign",
        userId: ctx.userId,
        to: tx.to,
        value: tx.value ?? "0",
        data: tx.data,
        description: stepLabel,
        autoSign: true,
        chainId: params.fromChainId,
        createdAt: now,
        expiresAt: now + SIGN_REQUEST_TTL_SECONDS,
        preview: previewForStep,
      };

      if (i === 0) {
        // First step: emit the mini-app button. The renderer also stores the
        // request in miniAppRequestCache as part of `mini_app` handling.
        await ctx.emit({
          kind: "mini_app",
          request: miniAppRequest,
          promptText:
            txs.length === 1
              ? `Tap below to execute the swap automatically.`
              : `Tap below to execute the swap (${txs.length} steps will be signed in one session).`,
          buttonText: "Execute Swap",
        });
      } else {
        // Subsequent steps: queue in the cache only. The FE's SignHandler
        // calls `GET /request/:id?after=<prevId>` after each successful step
        // and picks up the next queued request without re-opening the app.
        if (this.deps.miniAppRequestCache) {
          await this.deps.miniAppRequestCache.store(miniAppRequest);
          log.info(
            {
              step: "next-step-queued",
              userId: ctx.userId,
              stepIndex: i,
              totalSteps: txs.length,
              requestId,
              chainId: params.fromChainId,
            },
            "queued follow-up swap step in mini-app cache",
          );
        }
      }

      const resolution = await this.deps.signingRequestUseCase.waitFor(
        requestId,
        SIGN_WAIT_TIMEOUT_MS,
      );

      if (resolution.status === "rejected") {
        log.warn(
          { step: "failed", userId: ctx.userId, stepIndex: i, reason: "rejected" },
          "swap step rejected",
        );
        return midFlowSwapCard({
          headline: `Swap aborted at step ${i + 1} of ${txs.length}`,
          params,
          earlierHashes: txHashes,
          requestId: ctx.conversationId ?? newUuid(),
        });
      }
      if (resolution.status === "expired") {
        log.warn(
          { step: "failed", userId: ctx.userId, stepIndex: i, reason: "expired" },
          "swap step timed out",
        );
        return midFlowSwapCard({
          headline: `Swap timed out at step ${i + 1} of ${txs.length}`,
          params,
          earlierHashes: txHashes,
          requestId: ctx.conversationId ?? newUuid(),
        });
      }
      if (!resolution.txHash) {
        log.warn(
          { step: "failed", userId: ctx.userId, stepIndex: i, reason: "no_tx_hash" },
          "swap step approved but missing txHash",
        );
        return midFlowSwapCard({
          headline: `Step ${i + 1} approved with no transaction hash`,
          params,
          earlierHashes: txHashes,
          requestId: ctx.conversationId ?? newUuid(),
        });
      }
      log.info(
        {
          step: "submitted",
          userId: ctx.userId,
          stepIndex: i,
          hash: resolution.txHash,
        },
        "swap step signed",
      );
      txHashes.push(resolution.txHash);
    }

    const actionType =
      params.fromChainId === params.toChainId
        ? "swap_same_chain"
        : "swap_cross_chain";
    void this.deps.loyaltyUseCase
      ?.awardPoints({
        userId: ctx.userId,
        actionType,
        usdValue: undefined,
      })
      .catch(() => undefined);

    log.info(
      {
        step: "succeeded",
        userId: ctx.userId,
        actionType,
        txCount: txHashes.length,
      },
      "swap complete",
    );

    // Result-card framework: the renderer derives the explorer button from
    // `txHashes` (last entry = settlement tx) and "What's next" buttons
    // from `nextActions`. No manual InlineKeyboard.
    const sameChain = params.fromChainId === params.toChainId;
    const out =
      data.outputAmountFormatted ??
      (data.outputAmount ? `${data.outputAmount} raw` : "—");
    const finalHash = txHashes[txHashes.length - 1]!;
    const result: IntentResult = {
      status: "success",
      verb: "swap",
      headline: `You swapped ${params.amountHuman} ${params.fromToken.symbol} into ~${out} ${params.toToken.symbol}`,
      fields: [
        { label: "You sent", value: `${params.amountHuman} ${params.fromToken.symbol}` },
        { label: "You got", value: `~${out} ${params.toToken.symbol}`, emphasis: "primary" },
      ],
      txHashes: [{ hash: finalHash, chainId: params.fromChainId }],
      nextActions: [
        { label: "Earn yield on this", kind: "command", payload: "/yield" },
        { label: "Swap again", kind: "command", payload: "/swap" },
      ],
      complexity: sameChain && txHashes.length === 1 ? "simple" : "complex",
      interpreterContext:
        !sameChain || txHashes.length > 1
          ? {
              fromChainId: params.fromChainId,
              toChainId: params.toChainId,
              steps: txHashes.length,
            }
          : undefined,
    };
    return { kind: "result_card", result };
  }

  // ── Compile phase ────────────────────────────────────────────────────────

  private async initSession(
    ctx: CapabilityCtx,
    text: string,
  ): Promise<CollectResult<SwapParams>> {
    const compileResult = await this.deps.intentUseCase.compileSchema({
      manifest: SWAP_MANIFEST,
      messages: [text],
      userId: ctx.userId,
      partialParams: {},
    });

    const state: SessionState = {
      stage: "compile",
      messages: [text],
      partialParams: compileResult.params,
      tokenSymbols: compileResult.tokenSymbols,
      resolverFields: compileResult.resolverFields ?? {},
      compileTurns: 1,
      disambigTurns: 0,
      fromChainSymbol: compileResult.params.fromChainSymbol as
        | string
        | undefined,
      toChainSymbol: compileResult.params.toChainSymbol as string | undefined,
    };

    if (compileResult.missingQuestion) {
      return {
        kind: "ask",
        question: compileResult.missingQuestion,
        state: toPlain(state),
      };
    }
    return this.finishCompileOrResolve(ctx, state);
  }

  private async continueCompileLoop(
    ctx: CapabilityCtx,
    state: SessionState,
  ): Promise<CollectResult<SwapParams>> {
    if (state.compileTurns >= MAX_COMPILE_TURNS) {
      return this.abort(
        "I couldn't collect the full swap details after several attempts. Please start over.",
      );
    }
    state.compileTurns += 1;

    const compileResult = await this.deps.intentUseCase.compileSchema({
      manifest: SWAP_MANIFEST,
      messages: state.messages,
      userId: ctx.userId,
      partialParams: state.partialParams,
    });

    state.partialParams = { ...state.partialParams, ...compileResult.params };
    state.tokenSymbols = {
      ...state.tokenSymbols,
      ...compileResult.tokenSymbols,
    };
    state.resolverFields = {
      ...state.resolverFields,
      ...(compileResult.resolverFields ?? {}),
    };
    if (compileResult.params.fromChainSymbol)
      state.fromChainSymbol = compileResult.params.fromChainSymbol as string;
    if (compileResult.params.toChainSymbol)
      state.toChainSymbol = compileResult.params.toChainSymbol as string;

    if (compileResult.missingQuestion) {
      return {
        kind: "ask",
        question: compileResult.missingQuestion,
        state: toPlain(state),
      };
    }
    return this.finishCompileOrResolve(ctx, state);
  }

  // ── Resolver phase ───────────────────────────────────────────────────────

  private async finishCompileOrResolve(
    ctx: CapabilityCtx,
    state: SessionState,
  ): Promise<CollectResult<SwapParams>> {
    const missing = getMissingRequiredFields(
      SWAP_MANIFEST,
      state.partialParams,
    );
    if (missing.length > 0) {
      const question =
        await this.deps.intentUseCase.generateMissingParamQuestion(
          SWAP_MANIFEST,
          missing,
        );
      return { kind: "ask", question, state: toPlain(state) };
    }

    // Resolve chain ids early so we can validate against Relay coverage before
    // spending a round-trip on the resolver.
    const fromChainId = resolveChainSymbol(state.fromChainSymbol);
    const toChainId = resolveChainSymbol(state.toChainSymbol);
    if (fromChainId === null) {
      return this.abort(`Unknown origin chain: ${state.fromChainSymbol}`);
    }
    if (toChainId === null) {
      return this.abort(`Unknown destination chain: ${state.toChainSymbol}`);
    }
    if (!RELAY_SUPPORTED_CHAIN_IDS.includes(fromChainId)) {
      return this.abort(
        `Relay does not support swaps from this chain (id ${fromChainId}).`,
      );
    }
    if (!RELAY_SUPPORTED_CHAIN_IDS.includes(toChainId)) {
      return this.abort(
        `Relay does not support swaps to this chain (id ${toChainId}).`,
      );
    }

    // USDC short-circuit — mirror /send. When the user said "USDC" (or fiat
    // normalised to USDC by the schema compiler), replace the symbol-bearing
    // resolver field with the chain-canonical USDC address so the resolver
    // skips the USDC vs USDC.E disambiguation prompt entirely.
    if (isUsdcSymbol(state.tokenSymbols.from)) {
      const addr = getUsdcAddress(fromChainId);
      if (!addr) {
        return this.abort(
          "no usdc found for this chain, please try again with another token",
        );
      }
      const current = state.resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL];
      if (typeof current !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(current)) {
        state.resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] = addr;
      }
    }
    if (isUsdcSymbol(state.tokenSymbols.to)) {
      const addr = getUsdcAddress(toChainId);
      if (!addr) {
        return this.abort(
          "no usdc found for this chain, please try again with another token",
        );
      }
      const current = state.resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL];
      if (typeof current !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(current)) {
        state.resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL] = addr;
      }
    }

    try {
      // Token resolution is always scoped to the origin chain — the from-token
      // has to be swappable from there, and a same-chain swap puts the to-token
      // on the same chain too. Cross-chain to-token uses `toChainId` directly.
      const fromResolved = await this.deps.resolverEngine.resolve({
        resolverFields: {
          [RESOLVER_FIELD.FROM_TOKEN_SYMBOL]:
            state.resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL],
        },
        userId: ctx.userId,
        chainId: fromChainId,
      });
      const toResolved = await this.deps.resolverEngine.resolve({
        resolverFields: {
          [RESOLVER_FIELD.FROM_TOKEN_SYMBOL]:
            state.resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL],
        },
        userId: ctx.userId,
        chainId: toChainId,
      });

      const fromToken = fromResolved.fromToken;
      const toToken = toResolved.fromToken; // resolver returned the "from" slot because we passed the symbol there

      if (!fromToken) {
        return this.abort(
          `Origin token not found. Make sure it is supported on chain ${fromChainId}.`,
        );
      }
      if (!toToken) {
        return this.abort(
          `Destination token not found. Make sure it is supported on chain ${toChainId}.`,
        );
      }

      // Compute raw amount from humanAmount + origin token decimals.
      const humanAmount = state.resolverFields[RESOLVER_FIELD.READABLE_AMOUNT];
      if (!humanAmount) {
        return this.abort(
          "Missing amount. Please specify how much you want to swap.",
        );
      }
      const amountRaw = toRaw(humanAmount, fromToken.decimals);

      // Relay needs the SCA address (the on-chain account that holds the tokens),
      // not the EOA (the signer key). resolverEngine.senderAddress returns eoaAddress,
      // so we fetch smartAccountAddress directly from the profile here.
      const profile = await this.deps.userProfileRepo.findByUserId(ctx.userId);
      const userAddress = profile?.smartAccountAddress ?? null;
      if (!userAddress) {
        log.warn(
          { userId: ctx.userId },
          "smartAccountAddress not set — user may not have completed auth",
        );
        return this.abort(
          "Could not load your wallet address. Please sign in again.",
        );
      }

      log.info(
        {
          step: "resolved",
          userId: ctx.userId,
          fromToken: fromToken.symbol,
          toToken: toToken.symbol,
          amountHuman: humanAmount,
          amountRaw,
          fromChainId,
          toChainId,
          userAddress,
        },
        "swap params resolved",
      );

      return {
        kind: "ok",
        params: {
          fromToken,
          toToken,
          amountHuman: humanAmount,
          amountRaw,
          fromChainId,
          toChainId,
          userAddress,
        },
      };
    } catch (err) {
      if (err instanceof DisambiguationRequiredError) {
        log.debug(
          { symbol: err.symbol, candidates: err.candidates.length },
          "token disambiguation required",
        );
        return this.enterDisambiguation(state, err);
      }
      log.error({ err, userId: ctx.userId }, "swap resolve failed");
      return this.abort(
        `Could not resolve swap: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private enterDisambiguation(
    state: SessionState,
    err: DisambiguationRequiredError,
  ): CollectResult<SwapParams> {
    state.stage = "token_disambig";
    state.disambiguation = {
      resolvedFrom: null,
      resolvedTo: null,
      // The resolver engine uses slot names "from"/"to" internally; our
      // cross-chain flow issues both resolves via the "from" slot, so we use
      // the user-visible symbol to decide which side this disambiguation is
      // really about.
      awaitingSlot: err.symbol === state.tokenSymbols.to ? "to" : "from",
      fromCandidates:
        err.symbol === state.tokenSymbols.to ? [] : err.candidates,
      toCandidates: err.symbol === state.tokenSymbols.to ? err.candidates : [],
    };
    return {
      kind: "ask",
      question: buildDisambiguationPrompt(
        state.disambiguation.awaitingSlot,
        err.symbol,
        err.candidates,
      ),
      state: toPlain(state),
    };
  }

  private async handleDisambiguationReply(
    ctx: CapabilityCtx,
    text: string,
    state: SessionState,
  ): Promise<CollectResult<SwapParams>> {
    const pending = state.disambiguation;
    if (!pending) return this.abort("Session error. Please start over.");

    state.disambigTurns += 1;
    if (state.disambigTurns > MAX_DISAMBIG_TURNS) {
      return this.abort(
        "Too many disambiguation attempts — please start over.",
      );
    }

    const candidates =
      pending.awaitingSlot === "from"
        ? pending.fromCandidates
        : pending.toCandidates;
    const selected = pickCandidateByInput(text, candidates);
    if (!selected)
      return this.abort(
        "Disambiguation cancelled — please repeat your request.",
      );

    // Commit the selection back to resolverFields so the next resolve() sees
    // an exact address rather than a symbol.
    if (pending.awaitingSlot === "from") {
      state.resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] = selected.address;
    } else {
      state.resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL] = selected.address;
    }

    state.disambiguation = undefined;
    state.stage = "compile";
    return this.finishCompileOrResolve(ctx, state);
  }

  private abort(message: string): CollectResult<SwapParams> {
    // Pre-execution validation messages stay as `chat` — they're conversational
    // setup errors (e.g. "Unknown chain"), not capability outcomes. The
    // terminal-must-be-result_card rule applies to post-resolve outcomes.
    return { kind: "terminal", artifact: { kind: "chat", text: message } };
  }
}

function buildSwapPreview(
  params: SwapParams,
  data: RelaySwapToolOutputData,
  stepCount: number,
): IntentResult {
  const sameChain = params.fromChainId === params.toChainId;
  const out =
    data.outputAmountFormatted ??
    (data.outputAmount ? `${data.outputAmount} raw` : "—");
  return buildPreview({
    verb: "swap",
    headline: sameChain
      ? `Swap ${params.amountHuman} ${params.fromToken.symbol} for ~${out} ${params.toToken.symbol}`
      : `Swap ${params.amountHuman} ${params.fromToken.symbol} for ~${out} ${params.toToken.symbol} (cross-chain)`,
    fields: [
      { label: "You send", value: `${params.amountHuman} ${params.fromToken.symbol}` },
      { label: "You get", value: `~${out} ${params.toToken.symbol}`, emphasis: "primary" },
      ...(stepCount > 1
        ? [{ label: "Steps", value: `${stepCount}`, emphasis: "muted" as const }]
        : []),
    ],
  });
}

function swapFailedCard(
  interpreted: ReturnType<typeof interpretError>,
  params: SwapParams,
): Artifact {
  const result: IntentResult = {
    status: "failed",
    verb: "swap",
    headline: "Couldn't swap right now",
    fields: [
      { label: "Reason", value: interpreted.friendly },
      {
        label: "Wanted",
        value: `${params.amountHuman} ${params.fromToken.symbol} → ${params.toToken.symbol}`,
        emphasis: "muted",
      },
    ],
    nextActions: interpreted.recovery
      ? [
          {
            label: interpreted.recovery.label,
            kind: interpreted.recovery.kind,
            payload: interpreted.recovery.payload,
          },
          { label: "Try again", kind: "command", payload: "/swap" },
        ]
      : [{ label: "Try again", kind: "command", payload: "/swap" }],
    requestId: interpreted.requestId,
    errorCode: interpreted.code,
  };
  return { kind: "result_card", result };
}

function midFlowSwapCard(input: {
  headline: string;
  params: SwapParams;
  earlierHashes: string[];
  requestId: string;
}): Artifact {
  const result: IntentResult = {
    status: "failed",
    verb: "swap",
    headline: input.headline,
    fields: [
      {
        label: "Tried",
        value: `${input.params.amountHuman} ${input.params.fromToken.symbol} → ${input.params.toToken.symbol}`,
        emphasis: "muted",
      },
    ],
    txHashes: input.earlierHashes.map((h) => ({
      hash: h,
      chainId: input.params.fromChainId,
    })),
    nextActions: [{ label: "Try again", kind: "command", payload: "/swap" }],
    requestId: input.requestId,
  };
  return { kind: "result_card", result };
}

function toPlain(state: SessionState): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
}

function isUsdcSymbol(s?: string): boolean {
  if (!s) return false;
  return s.trim().toUpperCase() === "USDC";
}

/**
 * Seeded manifest used only to drive the LLM compile loop + resolver.
 * /swap never reaches a calldata-builder — Relay supplies the calldata.
 */
const SWAP_MANIFEST: CapabilityManifest = {
  toolId: "system-relay-swap",
  category: TOOL_CATEGORY.SWAP,
  name: "Relay Swap",
  description:
    "Swap one token for another on the same chain or across chains via relay.link.",
  inputSchema: {
    type: "object",
    properties: {
      fromTokenSymbol: { type: "string" },
      toTokenSymbol: { type: "string" },
      readableAmount: { type: "string" },
      fromChainSymbol: {
        type: "string",
        description:
          "Origin chain name, e.g. 'base', 'arbitrum'. Omit to default to the bot's configured chain.",
      },
      toChainSymbol: {
        type: "string",
        description: "Destination chain name. Omit for same-chain swaps.",
      },
    },
    required: ["fromTokenSymbol", "toTokenSymbol", "readableAmount"],
  },
  requiredFields: {
    [RESOLVER_FIELD.FROM_TOKEN_SYMBOL]: RESOLVER_FIELD.FROM_TOKEN_SYMBOL,
    [RESOLVER_FIELD.TO_TOKEN_SYMBOL]: RESOLVER_FIELD.TO_TOKEN_SYMBOL,
    [RESOLVER_FIELD.READABLE_AMOUNT]: RESOLVER_FIELD.READABLE_AMOUNT,
  },
};
