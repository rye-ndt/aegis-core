import { InlineKeyboard } from "grammy";
import { ASTER_ENV } from "../../../../helpers/env/asterEnv";
import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import { interpretError } from "../../../../helpers/errors/errorCatalog";
import { createLogger } from "../../../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type {
  IntentResult,
  IntentVerb,
} from "../../../../use-cases/interface/input/resultCard.types";
import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type {
  IStockUseCase,
  StockExecutionStep,
} from "../../../../use-cases/interface/input/stock.interface";
import type { IStockPairRegistry } from "../../../../use-cases/interface/output/stocks/stockPair.interface";
import type { ILoyaltyUseCase } from "../../../../use-cases/interface/input/loyalty.interface";
import type { ISigningRequestUseCase } from "../../../../use-cases/interface/input/signingRequest.interface";
import type { IMiniAppRequestCache } from "../../../../use-cases/interface/output/cache/miniAppRequest.cache";
import type { SignRequest } from "../../../../use-cases/interface/output/cache/miniAppRequest.types";
import type { SigningRequestRecord } from "../../../../use-cases/interface/output/cache/signingRequest.cache";
import { buildPreview } from "./buildPreview";

const log = createLogger("stockCapability");

const SIGN_REQUEST_TTL_SECONDS = 600;
const SIGN_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/** errorCodes that mean "the user said no" — don't try recovery. */
const NO_RECOVERY_CODES = new Set<string>([
  "user_rejected",
  "expired",
]);

type StockVerb = "buy" | "short" | "close" | "sell" | "sl" | "tp";

interface StockOpenParams {
  kind: "open";
  verb: "buy" | "short";
  symbol: string;
  amountUsd: string;
}
interface StockCloseParams {
  kind: "close";
  symbol: string;
  /** Set after disambiguation; resolved by `resolvePositionForSymbol`. */
  tradeHash?: `0x${string}`;
}
interface StockExitsParams {
  kind: "exits";
  verb: "sl" | "tp";
  symbol: string;
  priceUsd: string;
  tradeHash?: `0x${string}`;
}
type StockParams = StockOpenParams | StockCloseParams | StockExitsParams;

export interface StockCapabilityDeps {
  stockUseCase: IStockUseCase;
  signingRequestUseCase: ISigningRequestUseCase;
  /**
   * Used by `parseAmountSymbol` to resolve free-text symbol/company name
   * (e.g. "apple", "tesla") into a canonical ticker. Replaces the LLM-based
   * extraction we used to lean on for /stock buy.
   */
  stockPairRegistry: IStockPairRegistry;
  miniAppRequestCache?: IMiniAppRequestCache;
  loyaltyUseCase?: ILoyaltyUseCase;
  isStockCapabilityDisabled?: () => boolean;
}

/**
 * `/stock buy|short|close|sl|tp` capability. Sub-verb is parsed
 * deterministically from the message; only the symbol + numeric arguments
 * flow through schema-style extraction (regex here, not LLM — the surface
 * is small and the verbs unambiguous).
 *
 * The recovery flow on a venue-leg revert emits a SECOND mini-app session,
 * not chained inside the same session — see the impl plan P2.5 "Recovery
 * flow (CORRECTED design)" for the why.
 */
export class StockCapability implements Capability<StockParams> {
  readonly id = "intent_stock";
  readonly triggers: TriggerSpec = {
    commands: [INTENT_COMMAND.STOCK],
    callbackPrefix: "stock",
  };

  constructor(private readonly deps: StockCapabilityDeps) {}

  async collect(
    ctx: CapabilityCtx,
    resuming?: Record<string, unknown>,
  ): Promise<CollectResult<StockParams>> {
    if (this.deps.isStockCapabilityDisabled?.()) {
      return this.terminal(
        "Stock trading is temporarily unavailable. Please try again later.",
      );
    }

    if (ctx.input.kind === "callback") {
      return this.handleCallback(ctx, ctx.input.data, resuming);
    }
    if (ctx.input.kind !== "text") return this.abort("Unexpected input.");

    const text = ctx.input.text.trim();
    const stripped = text.replace(/^\/stock\s*/i, "").trim();
    const tokens = stripped.split(/\s+/);
    const verb = (tokens[0] ?? "").toLowerCase() as StockVerb | "";

    if (verb === "buy" || verb === "short") {
      // Hard-fail fast when the registry hasn't loaded yet — otherwise the
      // user gets a misleading "try /stock buy $100 AAPL" hint when the real
      // problem is that the DB hasn't been seeded by the crawler.
      if (this.deps.stockPairRegistry.symbols().length === 0) {
        log.warn(
          { step: "failed", reason: "registry-empty" },
          "stock catalogue not loaded — refusing /stock buy",
        );
        return this.terminal(
          "Stock catalogue is still loading — try again in a minute. " +
            "If this persists, ask an admin to verify the stock_pairs migration ran.",
        );
      }
      const parsed = parseAmountSymbol(tokens.slice(1), this.deps.stockPairRegistry);
      if (!parsed) return this.usageHint();
      return {
        kind: "ok",
        params: {
          kind: "open",
          verb,
          symbol: parsed.symbol,
          amountUsd: parsed.amountUsd,
        },
      };
    }

    if (verb === "close" || verb === "sell") {
      const raw = tokens[1];
      if (!raw) return this.usageHint();
      const resolved = this.deps.stockPairRegistry.resolveByQuery(raw);
      const symbol = resolved?.symbol ?? raw.toUpperCase();
      return { kind: "ok", params: { kind: "close", symbol } };
    }

    if (verb === "sl" || verb === "tp") {
      // /stock sl AAPL 150
      const raw = tokens[1];
      const priceUsd = tokens[2];
      if (!raw || !priceUsd || !/^\d+(\.\d+)?$/.test(priceUsd)) {
        return this.usageHint();
      }
      const resolved = this.deps.stockPairRegistry.resolveByQuery(raw);
      const symbol = resolved?.symbol ?? raw.toUpperCase();
      return {
        kind: "ok",
        params: { kind: "exits", verb, symbol, priceUsd },
      };
    }

    return this.usageHint();
  }

  async run(params: StockParams, ctx: CapabilityCtx): Promise<Artifact> {
    if (this.deps.isStockCapabilityDisabled?.()) {
      return stockSimpleFailedCard(
        verbForKind(params.kind),
        "Stock trading is temporarily unavailable. Please try again later.",
      );
    }
    try {
      if (params.kind === "open") return await this.runOpen(ctx, params);
      if (params.kind === "close") return await this.runClose(ctx, params);
      return await this.runExits(ctx, params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { step: "failed", err: msg, userId: ctx.userId, kind: params.kind },
        "stock run failed",
      );
      const interpreted = interpretError(err, {
        verb: verbForKind(params.kind),
        requestId: ctx.conversationId ?? newUuid(),
      });
      const result: IntentResult = {
        status: "failed",
        verb: verbForKind(params.kind),
        headline: "Stock action failed",
        fields: [{ label: "Reason", value: interpreted.friendly }],
        nextActions: interpreted.recovery
          ? [
              {
                label: interpreted.recovery.label,
                kind: interpreted.recovery.kind,
                payload: interpreted.recovery.payload,
              },
            ]
          : undefined,
        complexity: "simple",
        requestId: interpreted.requestId,
    errorCode: interpreted.code,
      };
      return { kind: "result_card", result };
    }
  }

  // ── open / short ─────────────────────────────────────────────────────────

  private async runOpen(
    ctx: CapabilityCtx,
    params: StockOpenParams,
  ): Promise<Artifact> {
    log.info(
      {
        step: "started",
        userId: ctx.userId,
        symbol: params.symbol,
        side: params.verb,
        notionalUsd: params.amountUsd,
      },
      "stock open started",
    );

    const plan = await this.deps.stockUseCase.buildOpenPlan({
      userId: ctx.userId,
      symbol: params.symbol,
      amountUsd: params.amountUsd,
      isShort: params.verb === "short",
    });

    log.info(
      {
        step: "quoted",
        userId: ctx.userId,
        symbol: plan.symbol,
        stepCount: plan.steps.length,
      },
      "open plan quoted",
    );

    const verb = "stock_buy" as const;
    const openVerbLabel = params.verb === "short" ? "Short" : "Buy";
    const headlineForOpen = (stepLabel: string) =>
      `${stepLabel} — ${openVerbLabel} $${params.amountUsd} ${plan.symbol}`;
    const previewsForOpen = plan.steps.map((s, i) =>
      buildPreview({
        verb,
        headline:
          plan.steps.length === 1
            ? `${openVerbLabel} $${params.amountUsd} of ${plan.symbol}`
            : headlineForOpen(s.label),
        fields: [
          { label: "Symbol", value: plan.symbol, emphasis: "primary" },
          { label: "Notional", value: `$${params.amountUsd}` },
          ...(plan.markPriceUsd
            ? [{ label: "Mark", value: `$${plan.markPriceUsd}` }]
            : []),
          { label: "Leverage", value: "1×", emphasis: "muted" as const },
          ...(plan.steps.length > 1
            ? [
                {
                  label: "Step",
                  value: `${i + 1} of ${plan.steps.length}`,
                  emphasis: "muted" as const,
                },
              ]
            : []),
        ],
      }),
    );
    const result = await this.executeSignSteps({
      ctx,
      steps: plan.steps,
      buttonText: params.verb === "short" ? "Execute Short" : "Execute Buy",
      promptText:
        plan.steps.length === 1
          ? "Tap below to execute the trade automatically."
          : `Tap below — all ${plan.steps.length} steps will be signed in one mini-app session.`,
      previews: previewsForOpen,
    });

    if (result.aborted) {
      // Recovery: only when at least one step succeeded (some funds may be
      // stranded on the venue chain) AND the failure is not a user rejection.
      if (
        ASTER_ENV.recoveryEnabled &&
        result.failedStepIndex > 0 &&
        !NO_RECOVERY_CODES.has(result.errorCode ?? "user_rejected")
      ) {
        log.info(
          {
            step: "recovery-started",
            userId: ctx.userId,
            symbol: plan.symbol,
            failedAt: result.failedStepIndex,
            errorCode: result.errorCode,
          },
          "open failed mid-flight — preparing recovery swap",
        );
        const recovery = await this.deps.stockUseCase
          .buildReturnSwapPlan({ userId: ctx.userId })
          .catch((err) => {
            log.error(
              { err, userId: ctx.userId },
              "buildReturnSwapPlan failed",
            );
            return null;
          });
        if (recovery && recovery.steps.length > 0) {
          await ctx.emit({
            kind: "chat",
            parseMode: "Markdown",
            text: [
              "*Open trade failed.*",
              "",
              result.userMessage,
              "",
              "Tap below to return your funds to the home chain.",
            ].join("\n"),
          });
          return await this.emitRecoveryMiniApp(ctx, recovery.steps);
        }
        // No balance to return → fall through to plain failure message.
        log.info(
          { step: "recovery-noop", userId: ctx.userId },
          "no venue balance to recover",
        );
      }
      return result.artifact;
    }

    // Loyalty fire-and-forget on success.
    const actionType =
      params.verb === "short" ? "stock_open_short" : "stock_open_long";
    void this.deps.loyaltyUseCase
      ?.awardPoints({
        userId: ctx.userId,
        actionType,
        usdValue: Number(params.amountUsd),
      })
      .catch(() => undefined);

    log.info(
      {
        step: "succeeded",
        userId: ctx.userId,
        symbol: plan.symbol,
        actionType,
        txCount: result.txHashes.length,
      },
      "stock open complete",
    );

    const finalHash = result.txHashes[result.txHashes.length - 1];
    const venueChainId = plan.steps[plan.steps.length - 1]?.chainId;
    const sideLabel = params.verb === "short" ? "Short" : "Long";
    const successCard: IntentResult = {
      status: "success",
      verb: "stock_buy",
      headline: `You opened a ${sideLabel.toLowerCase()} position on ${plan.symbol}`,
      fields: [
        { label: "Symbol", value: plan.symbol, emphasis: "primary" },
        { label: "Side", value: sideLabel },
        { label: "Notional", value: `$${params.amountUsd}` },
      ],
      txHashes:
        finalHash && venueChainId
          ? [{ hash: finalHash, chainId: venueChainId }]
          : undefined,
      nextActions: [
        { label: "Set TP", kind: "command", payload: `/stock tp ${plan.symbol}` },
        { label: "Set SL", kind: "command", payload: `/stock sl ${plan.symbol}` },
        { label: "Positions", kind: "command", payload: "/positions" },
      ],
      complexity: "complex",
      interpreterContext: {
        symbol: plan.symbol,
        side: sideLabel,
        notionalUsd: params.amountUsd,
      },
    };
    return { kind: "result_card", result: successCard };
  }

  // ── close ────────────────────────────────────────────────────────────────

  private async runClose(
    ctx: CapabilityCtx,
    params: StockCloseParams,
  ): Promise<Artifact> {
    let tradeHash = params.tradeHash;
    if (!tradeHash) {
      const resolution = await this.deps.stockUseCase.resolvePositionForSymbol(
        ctx.userId,
        params.symbol,
      );
      if (resolution.kind === "none") {
        return stockSimpleFailedCard(
          "stock_close",
          `No open ${params.symbol} position to close.`,
        );
      }
      if (resolution.kind === "many") {
        const kb = new InlineKeyboard();
        for (const p of resolution.positions) {
          kb.text(
            `${p.symbol} ${p.side} $${p.collateralUsd} (entry ${p.entryPriceUsd})`,
            `stock:close-pick:${p.tradeHash.slice(2, 14)}`,
          ).row();
        }
        // Cache positions briefly so the callback can resolve the short
        // hash back to the full one (FE callbacks have a tight payload limit).
        return {
          kind: "chat",
          text: `Multiple ${params.symbol} positions open — pick one:`,
          keyboard: kb,
        };
      }
      tradeHash = resolution.position.tradeHash;
    }

    const plan = await this.deps.stockUseCase.buildClosePlan({
      userId: ctx.userId,
      tradeHash,
    });
    const closeCtx = plan.closeContext;
    const previewsForClose = plan.steps.map((s, i) =>
      buildPreview({
        verb: "stock_close",
        headline:
          plan.steps.length === 1
            ? `Close your ${plan.symbol} position`
            : `${s.label} — Close ${plan.symbol}`,
        fields: [
          { label: "Symbol", value: plan.symbol, emphasis: "primary" },
          ...(closeCtx
            ? [
                {
                  label: "Side",
                  value: closeCtx.side === "short" ? "Short" : "Long",
                },
                {
                  label: "Collateral",
                  value: `$${closeCtx.collateralUsd}`,
                },
                {
                  label: "P&L",
                  value: `${closeCtx.unrealizedPnlUsd} USD`,
                },
              ]
            : []),
          ...(plan.steps.length > 1
            ? [
                {
                  label: "Step",
                  value: `${i + 1} of ${plan.steps.length}`,
                  emphasis: "muted" as const,
                },
              ]
            : []),
        ],
      }),
    );
    const result = await this.executeSignSteps({
      ctx,
      steps: plan.steps,
      buttonText: "Execute Close",
      promptText: "Tap below to close the position.",
      previews: previewsForClose,
    });
    if (result.aborted) return result.artifact;

    // Plan P3.1 step 3 — append the venue→home return swap so freed
    // collateral lands back on the user's home chain in the same mini-app
    // session. `buildReturnSwapPlan` reads the live SCA balance, so the
    // close tx must have settled (executeSignSteps awaits the receipt
    // resolution before returning).
    const returnPlan = await this.deps.stockUseCase
      .buildReturnSwapPlan({ userId: ctx.userId })
      .catch((err) => {
        log.error(
          { err, userId: ctx.userId, step: "return-swap-plan-failed" },
          "post-close return-swap plan failed",
        );
        return null;
      });

    let returnTxHashes: string[] = [];
    if (returnPlan && returnPlan.steps.length > 0) {
      log.info(
        {
          step: "return-swap-started",
          userId: ctx.userId,
          symbol: plan.symbol,
          stepCount: returnPlan.steps.length,
        },
        "appending return swap after close",
      );
      const returnResult = await this.executeSignSteps({
        ctx,
        steps: returnPlan.steps,
        buttonText: "Return Funds",
        promptText: "Returning your USDC to the home chain.",
        continueSession: true,
        planKind: "recovery",
      });
      if (returnResult.aborted) {
        log.warn(
          {
            step: "return-swap-failed",
            userId: ctx.userId,
            failedAt: returnResult.failedStepIndex,
            errorCode: returnResult.errorCode,
          },
          "post-close return swap aborted",
        );
        return returnResult.artifact;
      }
      returnTxHashes = returnResult.txHashes;
    }

    void this.deps.loyaltyUseCase
      ?.awardPoints({ userId: ctx.userId, actionType: "stock_close" })
      .catch(() => undefined);

    log.info(
      {
        step: "succeeded",
        userId: ctx.userId,
        symbol: plan.symbol,
        closeTxCount: result.txHashes.length,
        returnTxCount: returnTxHashes.length,
      },
      "stock close complete",
    );

    const closeHash = result.txHashes[result.txHashes.length - 1];
    const closeChainId = plan.steps[plan.steps.length - 1]?.chainId;
    const fields: IntentResult["fields"] = [
      { label: "Symbol", value: plan.symbol, emphasis: "primary" },
    ];
    if (returnTxHashes.length > 0) {
      fields.push({
        label: "Funds",
        value: "Returned to your home chain",
        emphasis: "muted",
      });
    }
    const successCard: IntentResult = {
      status: "success",
      verb: "stock_close",
      headline: `You closed your ${plan.symbol} position`,
      fields,
      txHashes:
        closeHash && closeChainId
          ? [{ hash: closeHash, chainId: closeChainId }]
          : undefined,
      nextActions: [
        { label: "Positions", kind: "command", payload: "/positions" },
        { label: "Buy more", kind: "command", payload: "/stock" },
      ],
      complexity: "simple",
    };
    return { kind: "result_card", result: successCard };
  }

  // ── sl / tp ──────────────────────────────────────────────────────────────

  private async runExits(
    ctx: CapabilityCtx,
    params: StockExitsParams,
  ): Promise<Artifact> {
    let tradeHash = params.tradeHash;
    if (!tradeHash) {
      const resolution = await this.deps.stockUseCase.resolvePositionForSymbol(
        ctx.userId,
        params.symbol,
      );
      if (resolution.kind === "none") {
        return stockSimpleFailedCard(
          "stock_set_exits",
          `No open ${params.symbol} position to update.`,
        );
      }
      if (resolution.kind === "many") {
        const kb = new InlineKeyboard();
        for (const p of resolution.positions) {
          kb.text(
            `${p.symbol} ${p.side} $${p.collateralUsd} (entry ${p.entryPriceUsd})`,
            `stock:exits-pick:${p.tradeHash.slice(2, 14)}:${params.verb}:${params.priceUsd}`,
          ).row();
        }
        return {
          kind: "chat",
          text: `Multiple ${params.symbol} positions open — pick one to set ${params.verb.toUpperCase()} on:`,
          keyboard: kb,
        };
      }
      tradeHash = resolution.position.tradeHash;
    }

    const plan = await this.deps.stockUseCase.buildSetExitsPlan({
      userId: ctx.userId,
      tradeHash,
      stopLossUsd: params.verb === "sl" ? params.priceUsd : undefined,
      takeProfitUsd: params.verb === "tp" ? params.priceUsd : undefined,
    });
    const result = await this.executeSignSteps({
      ctx,
      steps: plan.steps,
      buttonText: "Update Exits",
      promptText: "Tap below to update SL/TP.",
      preview: buildPreview({
        verb: "stock_set_exits",
        headline:
          params.verb === "sl"
            ? `Set stop-loss for ${plan.symbol} at $${params.priceUsd}`
            : `Set take-profit for ${plan.symbol} at $${params.priceUsd}`,
        fields: [
          { label: "Symbol", value: plan.symbol, emphasis: "primary" },
          {
            label: params.verb === "sl" ? "Stop-loss" : "Take-profit",
            value: `$${params.priceUsd}`,
          },
        ],
      }),
    });
    if (result.aborted) return result.artifact;

    const successCard: IntentResult = {
      status: "success",
      verb: "stock_set_exits",
      headline: `Updated ${params.verb.toUpperCase()} on ${plan.symbol}`,
      fields: [
        { label: "Symbol", value: plan.symbol, emphasis: "primary" },
        {
          label: params.verb === "sl" ? "Stop loss" : "Take profit",
          value: `$${params.priceUsd}`,
        },
      ],
      nextActions: [
        { label: "Positions", kind: "command", payload: "/positions" },
      ],
      complexity: "simple",
    };
    return { kind: "result_card", result: successCard };
  }

  // ── sign-step loop (mirrors yieldCapability.executeSignSteps) ──────────

  private async executeSignSteps(opts: {
    ctx: CapabilityCtx;
    steps: StockExecutionStep[];
    buttonText: string;
    promptText: string;
    /**
     * When true, the first step is queued into the mini-app cache instead
     * of emitted as a new `mini_app` artifact. The FE picks it up via the
     * `?after=<prevRequestId>` chaining poll — used by the close path to
     * append the return-swap leg in the same mini-app session.
     */
    continueSession?: boolean;
    /** Optional `planKind` stamped on every signing record so notifyResolved
     * can branch the success UX (recovery / return). */
    planKind?: "recovery";
    /** Attached to the FIRST step's signing-request only — modal-shown summary. */
    preview?: IntentResult;
    /**
     * Per-step preview overrides. When provided and `previews[i]` is set, it
     * is attached to step `i`'s signing record (and its mini-app cache entry
     * for chained steps). Falls back to `preview` for i===0 when this array
     * is omitted, preserving the legacy single-preview contract. Passing
     * `previews` is the way to surface "approve USDC" → "swap on BSC" →
     * "open AAPL long" labels distinctly inside the mini-app modal as the FE
     * chains through `?after=<prev>`.
     */
    previews?: (IntentResult | undefined)[];
  }): Promise<
    | {
        aborted: true;
        artifact: Artifact;
        failedStepIndex: number;
        errorCode?: string;
        userMessage: string;
      }
    | { aborted: false; txHashes: string[] }
  > {
    const { ctx, steps, buttonText, promptText, continueSession, planKind, preview, previews } = opts;
    const signing = this.deps.signingRequestUseCase;
    const chatId = Number(ctx.channelId);
    const txHashes: string[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const requestId = newUuid();
      const now = newCurrentUTCEpoch();
      const label =
        steps.length === 1 ? step.label : `${step.label} (${i + 1}/${steps.length})`;

      const previewForStep =
        previews?.[i] ?? (i === 0 && !continueSession ? preview : undefined);
      const record: SigningRequestRecord = {
        id: requestId,
        userId: ctx.userId,
        chatId,
        to: step.to,
        value: step.value,
        data: step.data,
        description: label,
        status: "pending",
        createdAt: now,
        expiresAt: now + SIGN_REQUEST_TTL_SECONDS,
        autoSign: true,
        tokenAddress: step.spendTokenAddress,
        amountRaw: step.spendAmountRaw,
        preview: previewForStep,
        ...(planKind ? { planKind } : {}),
      };
      await signing.create(record);

      const miniAppRequest: SignRequest = {
        requestId,
        requestType: "sign",
        userId: ctx.userId,
        to: step.to,
        value: step.value,
        data: step.data,
        description: label,
        autoSign: true,
        chainId: step.chainId,
        createdAt: now,
        expiresAt: now + SIGN_REQUEST_TTL_SECONDS,
        preview: previewForStep,
      };

      if (i === 0 && !continueSession) {
        await ctx.emit({
          kind: "mini_app",
          request: miniAppRequest,
          promptText,
          buttonText,
        });
      } else if (this.deps.miniAppRequestCache) {
        await this.deps.miniAppRequestCache.store(miniAppRequest);
      }

      log.debug(
        {
          step: "sign-step",
          userId: ctx.userId,
          stepIndex: i,
          totalSteps: steps.length,
          requestId,
          chainId: step.chainId,
        },
        "awaiting step signature",
      );

      const resolution = await signing.waitFor(
        requestId,
        SIGN_WAIT_TIMEOUT_MS,
      );

      if (resolution.status === "rejected") {
        const errorCode = resolution.errorCode;
        const userMessage =
          resolution.errorMessage ??
          (errorCode === "user_rejected"
            ? `You aborted at step ${i + 1} of ${steps.length}.`
            : `Step ${i + 1} of ${steps.length} failed${errorCode ? ` (${errorCode})` : ""}.`);
        log.warn(
          { step: "failed", userId: ctx.userId, stepIndex: i, errorCode, chainId: step.chainId },
          "stock step rejected",
        );
        return {
          aborted: true,
          failedStepIndex: i,
          errorCode,
          userMessage,
          artifact: stockStepFailedCard({
            headline: userMessage,
            txHashes,
            chainId: step.chainId,
          }),
        };
      }
      if (resolution.status === "expired") {
        log.warn(
          { step: "failed", userId: ctx.userId, stepIndex: i, reason: "expired" },
          "stock step timed out",
        );
        return {
          aborted: true,
          failedStepIndex: i,
          userMessage: `Step ${i + 1} of ${steps.length} timed out.`,
          artifact: stockStepFailedCard({
            headline: `Step ${i + 1} of ${steps.length} timed out`,
            txHashes,
            chainId: step.chainId,
          }),
        };
      }
      if (resolution.txHash) {
        txHashes.push(resolution.txHash);
        log.info(
          {
            step:
              i === 0 ? "swap-submitted" : i === steps.length - 1 ? "open-submitted" : "approve-submitted",
            userId: ctx.userId,
            stepIndex: i,
            chainId: step.chainId,
            hash: resolution.txHash,
          },
          "stock step signed",
        );
      }
    }
    return { aborted: false, txHashes };
  }

  private async emitRecoveryMiniApp(
    ctx: CapabilityCtx,
    steps: StockExecutionStep[],
  ): Promise<Artifact> {
    if (steps.length === 0) {
      return stockSimpleFailedCard(
        "stock_close",
        "No funds to recover. Contact support if you believe this is wrong.",
      );
    }
    const chatId = Number(ctx.channelId);
    const requestIds: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const requestId = newUuid();
      const now = newCurrentUTCEpoch();
      const label =
        steps.length === 1 ? step.label : `${step.label} (${i + 1}/${steps.length})`;
      const record: SigningRequestRecord = {
        id: requestId,
        userId: ctx.userId,
        chatId,
        to: step.to,
        value: step.value,
        data: step.data,
        description: label,
        status: "pending",
        createdAt: now,
        expiresAt: now + SIGN_REQUEST_TTL_SECONDS,
        autoSign: true,
        planKind: "recovery",
      };
      await this.deps.signingRequestUseCase.create(record);

      const req: SignRequest = {
        requestId,
        requestType: "sign",
        userId: ctx.userId,
        to: step.to,
        value: step.value,
        data: step.data,
        description: label,
        autoSign: true,
        chainId: step.chainId,
        createdAt: now,
        expiresAt: now + SIGN_REQUEST_TTL_SECONDS,
      };
      requestIds.push(requestId);

      if (i === 0) {
        // First step is returned as the terminal mini-app artifact below;
        // subsequent steps queue into the cache for FE chaining.
      } else if (this.deps.miniAppRequestCache) {
        await this.deps.miniAppRequestCache.store(req);
      }
    }

    // Emit the first recovery step as the terminal mini-app artifact. The
    // remaining steps were queued in the cache above. notifyResolved emits
    // the final user-facing message via the standard resolve path.
    const firstStep = steps[0]!;
    const firstRequestId = requestIds[0]!;
    const recoveryPreview = buildPreview({
      verb: "stock_close",
      headline: "Return your funds to your home chain",
      fields: [
        {
          label: "What this does",
          value: "Brings your USDC back from the trading venue.",
        },
        {
          label: "Steps",
          value:
            steps.length === 1
              ? "1 transaction"
              : `${steps.length} transactions in one session`,
          emphasis: "muted",
        },
      ],
    });
    const firstReq: SignRequest = {
      requestId: firstRequestId,
      requestType: "sign",
      userId: ctx.userId,
      to: firstStep.to,
      value: firstStep.value,
      data: firstStep.data,
      description:
        steps.length === 1 ? firstStep.label : `${firstStep.label} (1/${steps.length})`,
      autoSign: true,
      chainId: firstStep.chainId,
      createdAt: newCurrentUTCEpoch(),
      expiresAt: newCurrentUTCEpoch() + SIGN_REQUEST_TTL_SECONDS,
      preview: recoveryPreview,
    };
    log.info(
      { step: "recovery-emitted", userId: ctx.userId, stepCount: steps.length },
      "recovery mini-app emitted",
    );
    return {
      kind: "mini_app",
      request: firstReq,
      promptText: "Tap below to return your funds to your home chain.",
      buttonText: "Return Funds",
    };
  }

  // ── callbacks ────────────────────────────────────────────────────────────

  private async handleCallback(
    ctx: CapabilityCtx,
    data: string,
    _resuming?: Record<string, unknown>,
  ): Promise<CollectResult<StockParams>> {
    // stock:close-pick:<tradeHashShort>
    const suffix = data.replace(/^stock:/, "");
    if (suffix.startsWith("close-pick:")) {
      const short = suffix.slice("close-pick:".length);
      const positions = await this.deps.stockUseCase.listPositions(ctx.userId);
      const match = positions.find((p) => p.tradeHash.slice(2, 14) === short);
      if (!match) {
        return this.terminal(
          "That position is no longer open. Try /stock close <SYMBOL> again.",
        );
      }
      return {
        kind: "ok",
        params: {
          kind: "close",
          symbol: match.symbol,
          tradeHash: match.tradeHash,
        },
      };
    }
    // stock:exits-pick:<short>:<sl|tp>:<priceUsd>
    if (suffix.startsWith("exits-pick:")) {
      const rest = suffix.slice("exits-pick:".length);
      const [short, verb, priceUsd] = rest.split(":");
      if (
        !short ||
        (verb !== "sl" && verb !== "tp") ||
        !priceUsd ||
        !/^\d+(\.\d+)?$/.test(priceUsd)
      ) {
        return this.terminal("Could not resume that selection. Try the SL/TP command again.");
      }
      const positions = await this.deps.stockUseCase.listPositions(ctx.userId);
      const match = positions.find((p) => p.tradeHash.slice(2, 14) === short);
      if (!match) {
        return this.terminal(
          `That position is no longer open. Try /stock ${verb} <SYMBOL> ${priceUsd} again.`,
        );
      }
      return {
        kind: "ok",
        params: {
          kind: "exits",
          verb,
          symbol: match.symbol,
          priceUsd,
          tradeHash: match.tradeHash,
        },
      };
    }
    return this.terminal("Unknown stock action.");
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private usageHint(): CollectResult<StockParams> {
    return {
      kind: "terminal",
      artifact: {
        kind: "chat",
        text:
          "Try `/stock buy $100 AAPL` · `/stock short $100 TSLA` · " +
          "`/stock close NVDA` · `/stock sl AAPL 150` · `/stock tp AAPL 220`.",
        parseMode: "Markdown",
      },
    };
  }

  private abort(message: string): CollectResult<StockParams> {
    return { kind: "terminal", artifact: { kind: "chat", text: message } };
  }

  private terminal(message: string): CollectResult<StockParams> {
    return { kind: "terminal", artifact: { kind: "chat", text: message } };
  }
}

/**
 * Common English fillers. Skipped during symbol resolution so phrasings like
 * "$5 of apple" or "buy $10 worth of tsla" don't get treated as ticker
 * candidates. Compared lowercase, alphanumeric only.
 */
const STOP_WORDS = new Set([
  "of", "a", "an", "the", "in", "for", "on", "at", "to",
  "with", "and", "or", "worth", "stock", "shares", "share",
]);

/**
 * Parse `["$100", "AAPL"]`, `["AAPL", "$100"]`, or `["$5", "of", "apple"]`
 * into `{ amountUsd, symbol }`. Symbol resolution goes through the DB-backed
 * registry's `resolveByQuery` — so tickers ("AAPL"), company names ("apple"),
 * and aliases ("alphabet" → GOOG) all work. No LLM. Stop words are skipped.
 *
 * Returns null when no amount is present or when no token resolves to a
 * known symbol.
 */
function parseAmountSymbol(
  tokens: string[],
  registry: IStockPairRegistry,
): { amountUsd: string; symbol: string } | null {
  let amount: string | undefined;
  let symbol: string | undefined;
  for (const t of tokens) {
    if (!t) continue;
    const cleanedAmt = t.replace(/^\$/, "");
    if (!amount && /^\d+(\.\d+)?$/.test(cleanedAmt)) {
      amount = cleanedAmt;
      continue;
    }
    const lower = t.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!lower || STOP_WORDS.has(lower)) continue;
    if (!symbol) {
      const resolved = registry.resolveByQuery(t);
      if (resolved) symbol = resolved.symbol;
    }
  }
  if (!amount || !symbol) return null;
  return { amountUsd: amount, symbol };
}

function verbForKind(kind: StockParams["kind"]): IntentVerb {
  if (kind === "open") return "stock_buy";
  if (kind === "close") return "stock_close";
  return "stock_set_exits";
}

function stockSimpleFailedCard(verb: IntentVerb, reason: string): Artifact {
  const result: IntentResult = {
    status: "failed",
    verb,
    headline: "Couldn't run that stock action",
    fields: [{ label: "Reason", value: reason }],
    nextActions: [{ label: "Stock", kind: "command", payload: "/stock" }],
    complexity: "simple",
  };
  return { kind: "result_card", result };
}

function stockStepFailedCard(input: {
  headline: string;
  txHashes: string[];
  chainId: number;
}): Artifact {
  const result: IntentResult = {
    status: "failed",
    verb: "stock_buy",
    headline: input.headline,
    fields: [],
    txHashes: input.txHashes.map((h) => ({ hash: h, chainId: input.chainId })),
    nextActions: [{ label: "Try again", kind: "command", payload: "/stock" }],
    complexity: "simple",
  };
  return { kind: "result_card", result };
}

