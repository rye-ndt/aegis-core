import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import { RESOLVER_FIELD } from "../../../../helpers/enums/resolverField.enum";
import { TOOL_CATEGORY } from "../../../../helpers/enums/toolCategory.enum";
import {
  RELAY_SUPPORTED_CHAIN_IDS,
  resolveChainSymbol,
} from "../../../../helpers/chainConfig";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
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
  type ToolManifest,
  DisambiguationRequiredError,
} from "../../../../use-cases/interface/input/intent.interface";
import type { ISigningRequestUseCase } from "../../../../use-cases/interface/input/signingRequest.interface";
import type { IResolverEngine } from "../../../../use-cases/interface/output/resolver.interface";
import type { IExecutionEstimator } from "../../../../use-cases/interface/output/executionEstimator.interface";
import type { ITokenDelegationDB } from "../../../../use-cases/interface/output/repository/tokenDelegation.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { SignRequest } from "../../../../use-cases/interface/output/cache/miniAppRequest.types";
import type { SigningRequestRecord } from "../../../../use-cases/interface/output/cache/signingRequest.cache";
import { checkTokenDelegation } from "../../../../use-cases/implementations/aegisGuardInterceptor";
import type { RelaySwapTool, RelaySwapToolOutputData } from "../tools/system/relaySwap.tool";
import { buildDisambiguationPrompt } from "./send.messages";
import { getMissingRequiredFields, pickCandidateByInput } from "./send.utils";

const DEFAULT_MAX_COMPILE_TURNS = 10;
const MAX_COMPILE_TURNS = parseInt(
  process.env.MAX_TOOL_ROUNDS ?? String(DEFAULT_MAX_COMPILE_TURNS),
  10,
);
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
}

export interface SwapCapabilityDeps {
  intentUseCase: IIntentUseCase;
  resolverEngine: IResolverEngine;
  relaySwapTool: RelaySwapTool;
  signingRequestUseCase: ISigningRequestUseCase;
  tokenDelegationDB?: ITokenDelegationDB;
  executionEstimator?: IExecutionEstimator;
  userProfileRepo: IUserProfileDB;
  chainId: number;
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
    // Aegis-Guard delegation check on the origin token.
    if (
      !params.fromToken.isNative &&
      this.deps.tokenDelegationDB &&
      this.deps.executionEstimator
    ) {
      const guard = await checkTokenDelegation({
        userId: ctx.userId,
        fromToken: params.fromToken,
        amountHuman: params.amountHuman,
        amountRaw: params.amountRaw,
        tokenDelegationDB: this.deps.tokenDelegationDB,
        executionEstimator: this.deps.executionEstimator,
      });
      if (!guard.ok) {
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
      return { kind: "chat", text: `Swap failed: ${toolResult.error ?? "unknown error"}` };
    }
    const data = toolResult.data as RelaySwapToolOutputData;
    const txs = data.txs;

    await ctx.emit({
      kind: "chat",
      parseMode: "Markdown",
      text: this.buildQuoteSummary(params, data, txs.length),
    });

    // Sequence each transaction through the mini-app session-key flow.
    const txHashes: string[] = [];
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i]!;
      const stepLabel = `Relay swap step ${i + 1}/${txs.length}`;
      const requestId = newUuid();
      const now = newCurrentUTCEpoch();
      const chatId = Number(ctx.channelId);

      // Persist to the signing-request cache so the mini-app's
      // `POST /response` → `resolveRequest` path can match by id.
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
      };
      await this.deps.signingRequestUseCase.create(record);

      // Render a mini-app button whose requestId matches the signing record.
      const miniAppRequest: SignRequest = {
        requestId,
        requestType: "sign",
        userId: ctx.userId,
        to: tx.to,
        value: tx.value ?? "0",
        data: tx.data,
        description: stepLabel,
        autoSign: true,
        createdAt: now,
        expiresAt: now + SIGN_REQUEST_TTL_SECONDS,
      };
      await ctx.emit({
        kind: "mini_app",
        request: miniAppRequest,
        promptText: `${stepLabel} — tap to execute automatically.`,
        buttonText: `Execute step ${i + 1}/${txs.length}`,
      });

      const resolution = await this.deps.signingRequestUseCase.waitFor(
        requestId,
        SIGN_WAIT_TIMEOUT_MS,
      );

      if (resolution.status === "rejected") {
        return {
          kind: "chat",
          text: `❌ Swap aborted at step ${i + 1}/${txs.length}. Earlier steps: ${formatHashes(txHashes)}`,
        };
      }
      if (resolution.status === "expired") {
        return {
          kind: "chat",
          text: `⏱️ Swap timed out at step ${i + 1}/${txs.length}. Earlier steps: ${formatHashes(txHashes)}`,
        };
      }
      if (!resolution.txHash) {
        return {
          kind: "chat",
          text: `⚠️ Step ${i + 1} approved with no tx hash. Please check your wallet history.`,
        };
      }
      txHashes.push(resolution.txHash);
    }

    return {
      kind: "chat",
      parseMode: "Markdown",
      text: this.buildCompletionMessage(params, data, txHashes),
    };
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
      fromChainSymbol: compileResult.params.fromChainSymbol as string | undefined,
      toChainSymbol: compileResult.params.toChainSymbol as string | undefined,
    };

    if (compileResult.missingQuestion) {
      return { kind: "ask", question: compileResult.missingQuestion, state: toPlain(state) };
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
    state.tokenSymbols = { ...state.tokenSymbols, ...compileResult.tokenSymbols };
    state.resolverFields = { ...state.resolverFields, ...(compileResult.resolverFields ?? {}) };
    if (compileResult.params.fromChainSymbol) state.fromChainSymbol = compileResult.params.fromChainSymbol as string;
    if (compileResult.params.toChainSymbol) state.toChainSymbol = compileResult.params.toChainSymbol as string;

    if (compileResult.missingQuestion) {
      return { kind: "ask", question: compileResult.missingQuestion, state: toPlain(state) };
    }
    return this.finishCompileOrResolve(ctx, state);
  }

  // ── Resolver phase ───────────────────────────────────────────────────────

  private async finishCompileOrResolve(
    ctx: CapabilityCtx,
    state: SessionState,
  ): Promise<CollectResult<SwapParams>> {
    const missing = getMissingRequiredFields(SWAP_MANIFEST, state.partialParams);
    if (missing.length > 0) {
      const question = await this.deps.intentUseCase.generateMissingParamQuestion(
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
      return this.abort(`Relay does not support swaps from this chain (id ${fromChainId}).`);
    }
    if (!RELAY_SUPPORTED_CHAIN_IDS.includes(toChainId)) {
      return this.abort(`Relay does not support swaps to this chain (id ${toChainId}).`);
    }

    try {
      // Token resolution is always scoped to the origin chain — the from-token
      // has to be swappable from there, and a same-chain swap puts the to-token
      // on the same chain too. Cross-chain to-token uses `toChainId` directly.
      const fromResolved = await this.deps.resolverEngine.resolve({
        resolverFields: { [RESOLVER_FIELD.FROM_TOKEN_SYMBOL]: state.resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] },
        userId: ctx.userId,
        chainId: fromChainId,
      });
      const toResolved = await this.deps.resolverEngine.resolve({
        resolverFields: { [RESOLVER_FIELD.FROM_TOKEN_SYMBOL]: state.resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL] },
        userId: ctx.userId,
        chainId: toChainId,
      });

      const fromToken = fromResolved.fromToken;
      const toToken = toResolved.fromToken; // resolver returned the "from" slot because we passed the symbol there

      if (!fromToken) {
        return this.abort(`Origin token not found. Make sure it is supported on chain ${fromChainId}.`);
      }
      if (!toToken) {
        return this.abort(`Destination token not found. Make sure it is supported on chain ${toChainId}.`);
      }

      // Compute raw amount from humanAmount + origin token decimals.
      const humanAmount = state.resolverFields[RESOLVER_FIELD.READABLE_AMOUNT];
      if (!humanAmount) {
        return this.abort("Missing amount. Please specify how much you want to swap.");
      }
      const amountRaw = toRawAmount(humanAmount, fromToken.decimals);

      const senderAddress = fromResolved.senderAddress;
      if (!senderAddress) {
        return this.abort("Could not load your wallet address. Please sign in again.");
      }

      return {
        kind: "ok",
        params: {
          fromToken,
          toToken,
          amountHuman: humanAmount,
          amountRaw,
          fromChainId,
          toChainId,
          userAddress: senderAddress,
        },
      };
    } catch (err) {
      if (err instanceof DisambiguationRequiredError) {
        return this.enterDisambiguation(state, err);
      }
      return this.abort(`Could not resolve swap: ${err instanceof Error ? err.message : String(err)}`);
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
      fromCandidates: err.symbol === state.tokenSymbols.to ? [] : err.candidates,
      toCandidates: err.symbol === state.tokenSymbols.to ? err.candidates : [],
    };
    return {
      kind: "ask",
      question: buildDisambiguationPrompt(state.disambiguation.awaitingSlot, err.symbol, err.candidates),
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
      return this.abort("Too many disambiguation attempts — please start over.");
    }

    const candidates =
      pending.awaitingSlot === "from" ? pending.fromCandidates : pending.toCandidates;
    const selected = pickCandidateByInput(text, candidates);
    if (!selected) return this.abort("Disambiguation cancelled — please repeat your request.");

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

  // ── Messaging helpers ────────────────────────────────────────────────────

  private buildQuoteSummary(
    params: SwapParams,
    data: RelaySwapToolOutputData,
    stepCount: number,
  ): string {
    const sameChain = params.fromChainId === params.toChainId;
    const header = sameChain ? "*Swap quote*" : "*Cross-chain swap quote*";
    const out =
      data.outputAmountFormatted ??
      (data.outputAmount ? `${data.outputAmount} raw` : "—");
    const lines = [
      header,
      "",
      `From: ${params.amountHuman} ${params.fromToken.symbol} (chain ${params.fromChainId})`,
      `To:   ~${out} ${params.toToken.symbol} (chain ${params.toChainId})`,
      `Steps: ${stepCount}`,
      "",
      "Tap each step's button to execute it automatically.",
    ];
    return lines.join("\n");
  }

  private buildCompletionMessage(
    params: SwapParams,
    data: RelaySwapToolOutputData,
    txHashes: string[],
  ): string {
    const out =
      data.outputAmountFormatted ??
      (data.outputAmount ? `${data.outputAmount} raw` : "—");
    const lines = [
      "✅ *Swap complete*",
      "",
      `Sent:     ${params.amountHuman} ${params.fromToken.symbol}`,
      `Received: ~${out} ${params.toToken.symbol}`,
      "",
      "*Transaction hashes*",
      ...txHashes.map((h, i) => `${i + 1}. \`${h}\``),
    ];
    return lines.join("\n");
  }

  private abort(message: string): CollectResult<SwapParams> {
    return { kind: "terminal", artifact: { kind: "chat", text: message } };
  }
}

function toPlain(state: SessionState): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
}

function toRawAmount(human: string, decimals: number): string {
  const [whole, frac = ""] = human.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole ?? "0"}${fracPadded}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

function formatHashes(hashes: string[]): string {
  if (hashes.length === 0) return "none";
  return hashes.map((h) => `\`${h}\``).join(", ");
}

/**
 * Seeded manifest used only to drive the LLM compile loop + resolver.
 * /swap never reaches `buildRequestBody` / the solver registry — Relay
 * supplies the calldata. The empty `steps: []` is intentional; it would
 * violate `ToolManifestSchema.min(1)` if we tried to persist it, but we
 * never do — this object lives in memory and is not validated.
 */
const SWAP_MANIFEST: ToolManifest = {
  toolId: "system-relay-swap",
  category: TOOL_CATEGORY.SWAP,
  name: "Relay Swap",
  description:
    "Swap one token for another on the same chain or across chains via relay.link.",
  protocolName: "Relay",
  tags: ["swap", "relay", "cross-chain"],
  priority: 0,
  isDefault: true,
  chainIds: RELAY_SUPPORTED_CHAIN_IDS,
  steps: [],
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
