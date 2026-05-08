import { InlineKeyboard } from "grammy";
import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import { getYieldConfig } from "../../../../helpers/chainConfig";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type { IntentResult } from "../../../../use-cases/interface/input/resultCard.types";
import { buildPreview } from "./buildPreview";
import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type { IYieldOptimizerUseCase } from "../../../../use-cases/interface/yield/IYieldOptimizerUseCase";
import type { IMiniAppRequestCache } from "../../../../use-cases/interface/output/cache/miniAppRequest.cache";
import type { ISigningRequestUseCase } from "../../../../use-cases/interface/input/signingRequest.interface";
import type {
  SignRequest,
  SignKind,
  YieldDisplayMeta,
} from "../../../../use-cases/interface/output/cache/miniAppRequest.types";
import type { SigningRequestRecord } from "../../../../use-cases/interface/output/cache/signingRequest.cache";
import type { TxStep } from "../../../../use-cases/interface/yield/IYieldProtocolAdapter";
import type { ILoyaltyUseCase } from "../../../../use-cases/interface/input/loyalty.interface";
import type { YIELD_PROTOCOL_ID } from "../../../../helpers/enums/yieldProtocolId.enum";

const SIGN_REQUEST_TTL_SECONDS = 600;
const SIGN_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

type YieldStage = "idle" | "await_custom_pct";

interface YieldState {
  stage: YieldStage;
}

interface RebalanceParams {
  rebalance: true;
  chainId: number;
  tokenAddress: string;
  fromProtocol: string;
  toProtocol: string;
}

type YieldRunParams = { pct: number } | { withdraw: true } | RebalanceParams;

export interface YieldCapabilityDeps {
  optimizer: IYieldOptimizerUseCase;
  miniAppRequestCache?: IMiniAppRequestCache;
  signingRequestUseCase?: ISigningRequestUseCase;
  loyaltyUseCase?: ILoyaltyUseCase;
}

function formatHumanAmount(amountRaw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = amountRaw / base;
  const frac = amountRaw % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 2);
  return `${whole.toString()}.${fracStr}`;
}

function findStablecoin(chainId: number, tokenAddress: string) {
  const cfg = getYieldConfig(chainId);
  if (!cfg) return null;
  const needle = tokenAddress.toLowerCase();
  return cfg.stablecoins.find((s) => s.address.toLowerCase() === needle) ?? null;
}

export class YieldCapability implements Capability<YieldRunParams> {
  readonly id = "intent_yield";
  readonly triggers: TriggerSpec = {
    command: INTENT_COMMAND.YIELD,
    // Owns both the deposit/withdraw `yield:` family and the auto-rebalance
    // `rebalance:` family — the two share signing infra.
    callbackPrefix: ["yield", "rebalance"],
  };

  constructor(private readonly deps: YieldCapabilityDeps) {}

  async collect(
    ctx: CapabilityCtx,
    resuming?: Record<string, unknown>,
  ): Promise<CollectResult<YieldRunParams>> {
    const input = ctx.input;

    // Handle callback inputs
    if (input.kind === "callback") {
      return await this.handleCallback(ctx, input.data);
    }

    // Handle text inputs
    const text = input.text.trim();

    if (resuming) {
      const state = resuming as unknown as YieldState;
      if (state.stage === "await_custom_pct") {
        const pct = parseInt(text, 10);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
          return {
            kind: "ask",
            question: "Please enter a percentage between 1 and 100:",
            state: resuming,
          };
        }
        return { kind: "ok", params: { pct } };
      }
    }

    // /withdraw command
    if (text.startsWith(INTENT_COMMAND.WITHDRAW)) {
      return { kind: "ok", params: { withdraw: true } };
    }

    // /yield command — show nudge keyboard. Continuation is via the keyboard
    // callbacks (yield:opt:N / yield:custom / etc.), which match through the
    // registry — never via free-text resume. Persisting an idle pending slot
    // here would trap any subsequent free-text message ("how do I top up?")
    // into yieldCapability for the full TTL, re-asking this same question.
    return {
      kind: "ask",
      question: "How much of your idle USDC would you like to optimize?",
      keyboard: buildNudgeKeyboard(),
      state: {} as Record<string, unknown>,
      persist: false,
    };
  }

  async run(
    params: YieldRunParams,
    ctx: CapabilityCtx,
  ): Promise<Artifact> {
    if ("rebalance" in params) {
      return this.runRebalance(ctx, params);
    }
    if ("withdraw" in params) {
      return this.runWithdraw(ctx);
    }
    return this.runDeposit(ctx, params.pct);
  }

  private async runDeposit(ctx: CapabilityCtx, pct: number): Promise<Artifact> {
    const plan = await this.deps.optimizer.buildDepositPlan(ctx.userId, pct);
    if (!plan) {
      return yieldUnavailableCard(
        "yield_deposit",
        "No idle USDC found or no yield protocol available.",
      );
    }
    if (!this.deps.signingRequestUseCase) {
      return yieldUnavailableCard(
        "yield_deposit",
        "Signing service unavailable. Please try again later.",
      );
    }

    const stablecoin = findStablecoin(plan.chainId, plan.tokenAddress);
    const displayMeta: YieldDisplayMeta | undefined = stablecoin
      ? {
          protocolName: plan.protocolId,
          tokenSymbol: stablecoin.symbol,
          amountHuman: formatHumanAmount(BigInt(plan.amountRaw), stablecoin.decimals),
        }
      : undefined;
    const amountHuman = displayMeta?.amountHuman ?? plan.amountRaw;
    const tokenSymbol = displayMeta?.tokenSymbol ?? "USDC";

    // Pre-sign Telegram quote ("*Yield deposit quote*…") removed — the
    // summary now lives in the mini-app modal via `preview` so the user sees
    // it next to the approve button rather than as a separate Telegram chat.
    const result = await this.executeSignSteps({
      ctx,
      steps: plan.txSteps,
      labelPrefix: "Yield deposit",
      kind: "yield_deposit",
      chainId: plan.chainId,
      protocolId: plan.protocolId,
      tokenAddress: plan.tokenAddress,
      spendAmountRaw: plan.amountRaw,
      displayMeta,
      buttonText: "Execute Deposit",
      promptText:
        plan.txSteps.length === 1
          ? "Tap the button below to execute the deposit automatically."
          : `Tap the button below — all ${plan.txSteps.length} steps will be signed in one mini-app session.`,
      preview: buildPreview({
        verb: "yield_deposit",
        headline: `Deposit ${amountHuman} ${tokenSymbol} into ${plan.protocolId}`,
        fields: [
          { label: "Amount", value: `${amountHuman} ${tokenSymbol}`, emphasis: "primary" },
          { label: "Protocol", value: plan.protocolId },
          ...(plan.txSteps.length > 1
            ? [{ label: "Steps", value: `${plan.txSteps.length}`, emphasis: "muted" as const }]
            : []),
        ],
      }),
    });

    if (result.aborted) return result.artifact;

    const txHash = result.txHashes[result.txHashes.length - 1];
    if (txHash) {
      await this.deps.optimizer.finalizeDeposit(ctx.userId, txHash);
      const usdValue = stablecoin
        ? Number(BigInt(plan.amountRaw)) / Math.pow(10, stablecoin.decimals)
        : undefined;
      void this.deps.loyaltyUseCase?.awardPoints({
        userId: ctx.userId,
        actionType: "yield_deposit",
        usdValue,
      }).catch(() => undefined);
    }

    const successResult: IntentResult = {
      status: "success",
      verb: "yield_deposit",
      headline: `You deposited ${amountHuman} ${tokenSymbol} into ${plan.protocolId}`,
      fields: [
        { label: "Amount", value: `${amountHuman} ${tokenSymbol}`, emphasis: "primary" },
        { label: "Protocol", value: plan.protocolId },
        { label: "Allocation", value: `${pct}% of idle balance`, emphasis: "muted" },
      ],
      txHashes: txHash ? [{ hash: txHash, chainId: plan.chainId }] : undefined,
      nextActions: [
        { label: "Withdraw", kind: "command", payload: "/withdraw" },
        { label: "Yield", kind: "command", payload: "/yield" },
      ],
      complexity: "simple",
    };
    return { kind: "result_card", result: successResult };
  }

  private async runWithdraw(ctx: CapabilityCtx): Promise<Artifact> {
    const plan = await this.deps.optimizer.buildWithdrawAllPlan(ctx.userId);
    if (!plan) {
      return yieldUnavailableCard(
        "yield_withdraw",
        "No active yield positions found to withdraw.",
      );
    }
    if (!this.deps.signingRequestUseCase) {
      return yieldUnavailableCard(
        "yield_withdraw",
        "Signing service unavailable. Please try again later.",
      );
    }

    const first = plan.withdrawals[0];
    const stablecoin = first ? findStablecoin(first.chainId, first.tokenAddress) : null;
    const displayMeta: YieldDisplayMeta | undefined = first && stablecoin
      ? {
          protocolName: first.protocolId,
          tokenSymbol: stablecoin.symbol,
          amountHuman: formatHumanAmount(BigInt(first.balanceRaw), stablecoin.decimals),
        }
      : undefined;
    const amountHuman = displayMeta?.amountHuman ?? "your balance";
    const tokenSymbol = displayMeta?.tokenSymbol ?? "USDC";
    const protocolLabel = first?.protocolId ?? "Aegis yield";

    const result = await this.executeSignSteps({
      ctx,
      steps: plan.txSteps,
      labelPrefix: "Withdraw",
      kind: "yield_withdraw",
      chainId: first?.chainId,
      protocolId: first?.protocolId,
      tokenAddress: first?.tokenAddress,
      displayMeta,
      buttonText: "Execute Withdrawal",
      promptText:
        plan.txSteps.length === 1
          ? "Tap the button below to execute the withdrawal automatically."
          : `Tap the button below — all ${plan.txSteps.length} steps will be signed in one mini-app session.`,
      preview: buildPreview({
        verb: "yield_withdraw",
        headline: `Withdraw ${amountHuman} ${tokenSymbol} from ${protocolLabel}`,
        fields: [
          { label: "Amount", value: `${amountHuman} ${tokenSymbol}`, emphasis: "primary" },
          { label: "Protocol", value: protocolLabel },
        ],
      }),
    });

    if (result.aborted) return result.artifact;

    await this.deps.optimizer.finalizeWithdrawal(
      ctx.userId,
      plan.withdrawals.map((w) => ({
        chainId: w.chainId,
        protocolId: w.protocolId,
        tokenAddress: w.tokenAddress,
        amountRaw: w.balanceRaw,
      })),
    );

    const finalHash = result.txHashes[result.txHashes.length - 1];
    const successResult: IntentResult = {
      status: "success",
      verb: "yield_withdraw",
      headline: `You withdrew ${amountHuman} ${tokenSymbol}`,
      fields: [
        { label: "Amount", value: `${amountHuman} ${tokenSymbol}`, emphasis: "primary" },
        { label: "Protocol", value: protocolLabel },
      ],
      txHashes: finalHash && first
        ? [{ hash: finalHash, chainId: first.chainId }]
        : undefined,
      nextActions: [
        { label: "Deposit again", kind: "command", payload: "/yield" },
        { label: "Send", kind: "command", payload: "/send" },
      ],
      complexity: "simple",
    };
    return { kind: "result_card", result: successResult };
  }

  private async executeSignSteps(opts: {
    ctx: CapabilityCtx;
    steps: TxStep[];
    labelPrefix: string;
    kind?: SignKind;
    chainId?: number;
    protocolId?: string;
    tokenAddress?: string;
    // When set, the LAST step's signing-request record is tagged with
    // tokenAddress + this amount so the resolver bumps spent_raw on success.
    // Deposits set this; withdrawals leave it undefined (they don't consume
    // the user's underlying-token delegation).
    spendAmountRaw?: string;
    displayMeta?: YieldDisplayMeta;
    buttonText: string;
    promptText: string;
    /** Attached to the FIRST step's signing-request only — modal-shown summary. */
    preview?: IntentResult;
  }): Promise<
    | { aborted: true; artifact: Artifact }
    | { aborted: false; txHashes: string[] }
  > {
    const {
      ctx,
      steps,
      labelPrefix,
      kind,
      chainId,
      protocolId,
      tokenAddress,
      spendAmountRaw,
      displayMeta,
      buttonText,
      promptText,
      preview,
    } = opts;
    const signingUseCase = this.deps.signingRequestUseCase!;
    const chatId = Number(ctx.channelId);
    const txHashes: string[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const requestId = newUuid();
      const now = newCurrentUTCEpoch();
      const label =
        steps.length === 1 ? labelPrefix : `${labelPrefix} step ${i + 1}/${steps.length}`;

      const isLastStep = i === steps.length - 1;
      const attributesSpend = isLastStep && !!spendAmountRaw && !!tokenAddress;
      const record: SigningRequestRecord = {
        id: requestId,
        userId: ctx.userId,
        chatId,
        to: step.to,
        value: step.value.toString(),
        data: step.data,
        description: label,
        status: "pending",
        createdAt: now,
        expiresAt: now + SIGN_REQUEST_TTL_SECONDS,
        autoSign: true,
        tokenAddress: attributesSpend ? tokenAddress!.toLowerCase() : undefined,
        amountRaw: attributesSpend ? spendAmountRaw : undefined,
        preview: i === 0 ? preview : undefined,
        // Suppress notifyResolved's generic card on intermediate steps — the
        // capability emits the rich final card after the last step. Without
        // this the user gets "✅ Transaction confirmed" between approve and
        // supply and assumes the deposit is already complete.
        silentResolution: !isLastStep,
      };
      await signingUseCase.create(record);

      const miniAppRequest: SignRequest = {
        requestId,
        requestType: "sign",
        userId: ctx.userId,
        to: step.to,
        value: step.value.toString(),
        data: step.data,
        description: label,
        autoSign: true,
        createdAt: now,
        expiresAt: now + SIGN_REQUEST_TTL_SECONDS,
        kind,
        chainId,
        protocolId,
        tokenAddress,
        // Display meta lives on the first step only — follow-up approve/supply steps
        // shouldn't re-render a "Confirm Deposit" screen.
        displayMeta: i === 0 ? displayMeta : undefined,
        preview: i === 0 ? preview : undefined,
      };

      if (i === 0) {
        // First step: emit the mini-app button. The renderer also stores the
        // request in miniAppRequestCache as part of `mini_app` handling.
        await ctx.emit({
          kind: "mini_app",
          request: miniAppRequest,
          promptText,
          buttonText,
        });
      } else {
        // Subsequent steps: queue silently. The FE picks them up via
        // `fetchNextRequest` after the previous step succeeds, so the user
        // opens the mini app exactly once per yield operation.
        if (this.deps.miniAppRequestCache) {
          await this.deps.miniAppRequestCache.store(miniAppRequest);
        }
      }

      const resolution = await signingUseCase.waitFor(requestId, SIGN_WAIT_TIMEOUT_MS);

      if (resolution.status === "rejected") {
        return {
          aborted: true,
          artifact: yieldStepFailedCard(labelPrefix, "aborted", i, steps.length),
        };
      }
      if (resolution.status === "expired") {
        return {
          aborted: true,
          artifact: yieldStepFailedCard(labelPrefix, "timed out", i, steps.length),
        };
      }
      if (resolution.txHash) {
        txHashes.push(resolution.txHash);
      }
    }

    return { aborted: false, txHashes };
  }

  private async handleCallback(
    ctx: CapabilityCtx,
    data: string,
  ): Promise<CollectResult<YieldRunParams>> {
    if (data.startsWith("rebalance:")) {
      return this.handleRebalanceCallback(ctx, data);
    }
    const suffix = data.replace(/^yield:/, "");

    if (suffix === "skip") {
      return {
        kind: "terminal",
        artifact: {
          kind: "chat",
          text: "No problem — I'll check again tomorrow.",
        },
      };
    }

    if (suffix === "custom") {
      return {
        kind: "ask",
        question: "Enter the percentage of your idle USDC to deposit (1–100):",
        state: { stage: "await_custom_pct" } as Record<string, unknown>,
      };
    }

    if (suffix.startsWith("opt:")) {
      const pctStr = suffix.slice(4);
      const pct = parseInt(pctStr, 10);
      if (Number.isFinite(pct) && pct > 0 && pct <= 100) {
        return { kind: "ok", params: { pct } };
      }
    }

    return {
      kind: "terminal",
      artifact: { kind: "chat", text: "Unknown yield action." },
    };
  }

  private async handleRebalanceCallback(
    ctx: CapabilityCtx,
    data: string,
  ): Promise<CollectResult<YieldRunParams>> {
    // rebalance:y:<chainId>:<token>:<from>:<to>
    // rebalance:n:<chainId>:<token>
    const parts = data.split(":");
    const verb = parts[1];

    if (verb === "n") {
      // Decline: clear the pending lock so future ticks aren't blocked. The
      // 24h cooldown set at nudge-time still suppresses re-nudging.
      await this.deps.optimizer.clearRebalancePending(ctx.userId);
      return {
        kind: "terminal",
        artifact: {
          kind: "chat",
          text: "Got it — I'll check again later.",
        },
      };
    }

    if (verb === "y" && parts.length >= 6) {
      const chainId = parseInt(parts[2] ?? "", 10);
      const tokenAddress = parts[3] ?? "";
      const fromProtocol = parts[4] ?? "";
      const toProtocol = parts[5] ?? "";
      if (Number.isFinite(chainId) && tokenAddress && fromProtocol && toProtocol) {
        return {
          kind: "ok",
          params: {
            rebalance: true,
            chainId,
            tokenAddress,
            fromProtocol,
            toProtocol,
          },
        };
      }
    }

    return {
      kind: "terminal",
      artifact: { kind: "chat", text: "Unknown rebalance action." },
    };
  }

  private async runRebalance(
    ctx: CapabilityCtx,
    params: RebalanceParams,
  ): Promise<Artifact> {
    if (!this.deps.signingRequestUseCase) {
      return yieldUnavailableCard(
        "yield_rebalance",
        "Signing service unavailable. Please try again later.",
      );
    }

    const plan = await this.deps.optimizer.buildRebalancePlan(ctx.userId, {
      chainId: params.chainId,
      tokenAddress: params.tokenAddress,
      fromProtocol: params.fromProtocol as YIELD_PROTOCOL_ID,
      toProtocol: params.toProtocol as YIELD_PROTOCOL_ID,
    });
    if (!plan) {
      // Position vanished between nudge and tap. Clear the lock so the user
      // isn't stuck pending forever.
      await this.deps.optimizer.clearRebalancePending(ctx.userId);
      const noPlan: IntentResult = {
        status: "failed",
        verb: "yield_rebalance",
        headline: "Nothing to rebalance",
        fields: [
          { label: "Reason", value: "Looks like you already withdrew — nothing to rebalance." },
        ],
        nextActions: [{ label: "Yield", kind: "command", payload: "/yield" }],
        complexity: "simple",
      };
      return { kind: "result_card", result: noPlan };
    }

    const stablecoin = findStablecoin(plan.chainId, plan.tokenAddress);
    const amountHuman = stablecoin
      ? formatHumanAmount(BigInt(plan.amountRaw), stablecoin.decimals)
      : plan.amountRaw;
    const tokenSymbol = stablecoin?.symbol ?? "USDC";

    // Pre-sign Telegram quote removed — moved into mini-app via `preview`.
    const fromApyPct = (plan.fromApy * 100).toFixed(2);
    const toApyPct = (plan.toApy * 100).toFixed(2);
    const result = await this.executeSignSteps({
      ctx,
      steps: plan.txSteps,
      labelPrefix: "Yield rebalance",
      // No `kind` — mini app falls back to its default sign UI rather than the
      // deposit/withdraw confirm screens (those would mislabel one of the legs).
      kind: undefined,
      chainId: plan.chainId,
      protocolId: plan.toProtocol,
      tokenAddress: plan.tokenAddress,
      // Spend bookkeeping: tag ONLY the last step (the supply call). The
      // withdraw leg burns aTokens and doesn't consume the user's USDC delegation.
      spendAmountRaw: plan.amountRaw,
      // Skip displayMeta for now — first step is a withdraw, so the
      // deposit-styled confirm card would be wrong.
      displayMeta: undefined,
      buttonText: "Execute Rebalance",
      promptText:
        plan.txSteps.length === 1
          ? "Tap the button below to execute the rebalance automatically."
          : `Tap the button below — all ${plan.txSteps.length} steps will be signed in one mini-app session.`,
      preview: buildPreview({
        verb: "yield_rebalance",
        headline: `Move ${amountHuman} ${tokenSymbol} from ${plan.fromProtocol} to ${plan.toProtocol}`,
        fields: [
          { label: "Amount", value: `${amountHuman} ${tokenSymbol}`, emphasis: "primary" },
          { label: "From", value: `${plan.fromProtocol} (~${fromApyPct}% APY)` },
          { label: "To", value: `${plan.toProtocol} (~${toApyPct}% APY)` },
        ],
      }),
    });

    if (result.aborted) {
      // Resolution failed — clear pending so we don't leave the user blocked.
      await this.deps.optimizer.clearRebalancePending(ctx.userId);
      return result.artifact;
    }

    await this.deps.optimizer.finalizeRebalance(ctx.userId, {
      chainId: plan.chainId,
      tokenAddress: plan.tokenAddress,
      fromProtocol: plan.fromProtocol,
      toProtocol: plan.toProtocol,
    });

    const usdValue = stablecoin
      ? Number(BigInt(plan.amountRaw)) / Math.pow(10, stablecoin.decimals)
      : undefined;
    void this.deps.loyaltyUseCase
      ?.awardPoints({
        userId: ctx.userId,
        actionType: "yield_deposit",
        usdValue,
      })
      .catch(() => undefined);

    const finalHash = result.txHashes[result.txHashes.length - 1];
    const successResult: IntentResult = {
      status: "success",
      verb: "yield_rebalance",
      headline: `You moved ${amountHuman} ${tokenSymbol} into ${plan.toProtocol}`,
      fields: [
        { label: "Amount", value: `${amountHuman} ${tokenSymbol}`, emphasis: "primary" },
        { label: "From", value: `${plan.fromProtocol} (~${fromApyPct}% APY)`, emphasis: "muted" },
        { label: "To", value: `${plan.toProtocol} (~${toApyPct}% APY)` },
      ],
      txHashes: finalHash ? [{ hash: finalHash, chainId: plan.chainId }] : undefined,
      nextActions: [
        { label: "Yield", kind: "command", payload: "/yield" },
        { label: "Withdraw", kind: "command", payload: "/withdraw" },
      ],
      complexity: "complex",
      interpreterContext: {
        fromProtocol: plan.fromProtocol,
        toProtocol: plan.toProtocol,
        fromApy: plan.fromApy,
        toApy: plan.toApy,
        sizeUsd: amountHuman,
      },
    };
    return { kind: "result_card", result: successResult };
  }
}

function yieldUnavailableCard(
  verb: "yield_deposit" | "yield_withdraw" | "yield_rebalance",
  reason: string,
): Artifact {
  const result: IntentResult = {
    status: "failed",
    verb,
    headline: "Couldn't run that yield action",
    fields: [{ label: "Reason", value: reason }],
    nextActions: [{ label: "Yield", kind: "command", payload: "/yield" }],
    complexity: "simple",
  };
  return { kind: "result_card", result };
}

function yieldStepFailedCard(
  labelPrefix: string,
  reason: "aborted" | "timed out",
  stepIndex: number,
  totalSteps: number,
): Artifact {
  const result: IntentResult = {
    status: "failed",
    verb: "yield_deposit",
    headline: `${labelPrefix} ${reason} at step ${stepIndex + 1} of ${totalSteps}`,
    fields: [
      { label: "Reason", value: reason === "aborted" ? "You declined or canceled" : "The signing window expired" },
    ],
    nextActions: [{ label: "Try again", kind: "command", payload: "/yield" }],
    complexity: "simple",
  };
  return { kind: "result_card", result };
}

export function buildRebalanceNudgeKeyboard(args: {
  chainId: number;
  tokenAddress: string;
  fromProtocol: string;
  toProtocol: string;
}): InlineKeyboard {
  const yes = `rebalance:y:${args.chainId}:${args.tokenAddress.toLowerCase()}:${args.fromProtocol}:${args.toProtocol}`;
  const no = `rebalance:n:${args.chainId}:${args.tokenAddress.toLowerCase()}`;
  return new InlineKeyboard().text("Yes, move it", yes).text("Skip for now", no);
}

export function buildNudgeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("25%", "yield:opt:25")
    .text("50%", "yield:opt:50")
    .text("75%", "yield:opt:75")
    .row()
    .text("Custom amount", "yield:custom")
    .text("Skip", "yield:skip");
}

