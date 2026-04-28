import { InlineKeyboard } from "grammy";
import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import { getYieldConfig } from "../../../../helpers/chainConfig";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
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

const SIGN_REQUEST_TTL_SECONDS = 600;
const SIGN_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

type YieldStage = "idle" | "await_custom_pct";

interface YieldState {
  stage: YieldStage;
}

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

export class YieldCapability implements Capability<{ pct: number } | { withdraw: true }> {
  readonly id = "intent_yield";
  readonly triggers: TriggerSpec = {
    command: INTENT_COMMAND.YIELD,
    callbackPrefix: "yield",
  };

  constructor(private readonly deps: YieldCapabilityDeps) {}

  async collect(
    ctx: CapabilityCtx,
    resuming?: Record<string, unknown>,
  ): Promise<CollectResult<{ pct: number } | { withdraw: true }>> {
    const input = ctx.input;

    // Handle callback inputs
    if (input.kind === "callback") {
      return this.handleCallback(ctx, input.data);
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

    // /yield command — show nudge keyboard
    return {
      kind: "ask",
      question: "How much of your idle USDC would you like to optimize?",
      keyboard: buildNudgeKeyboard(),
      state: { stage: "idle" } as unknown as Record<string, unknown>,
    };
  }

  async run(
    params: { pct: number } | { withdraw: true },
    ctx: CapabilityCtx,
  ): Promise<Artifact> {
    if ("withdraw" in params) {
      return this.runWithdraw(ctx);
    }
    return this.runDeposit(ctx, params.pct);
  }

  private async runDeposit(ctx: CapabilityCtx, pct: number): Promise<Artifact> {
    const plan = await this.deps.optimizer.buildDepositPlan(ctx.userId, pct);
    if (!plan) {
      return { kind: "chat", text: "No idle USDC found or no yield protocol available." };
    }
    if (!this.deps.signingRequestUseCase) {
      return { kind: "chat", text: "Signing service unavailable. Please try again later." };
    }

    const stablecoin = findStablecoin(plan.chainId, plan.tokenAddress);
    const displayMeta: YieldDisplayMeta | undefined = stablecoin
      ? {
          protocolName: plan.protocolId,
          tokenSymbol: stablecoin.symbol,
          amountHuman: formatHumanAmount(BigInt(plan.amountRaw), stablecoin.decimals),
        }
      : undefined;

    await ctx.emit({
      kind: "chat",
      parseMode: "Markdown",
      text: buildDepositQuoteSummary(plan, displayMeta, plan.txSteps.length),
    });

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

    return {
      kind: "chat",
      parseMode: "Markdown",
      text: buildDepositSuccessMessage(pct, result.txHashes),
    };
  }

  private async runWithdraw(ctx: CapabilityCtx): Promise<Artifact> {
    const plan = await this.deps.optimizer.buildWithdrawAllPlan(ctx.userId);
    if (!plan) {
      return { kind: "chat", text: "No active yield positions found to withdraw." };
    }
    if (!this.deps.signingRequestUseCase) {
      return { kind: "chat", text: "Signing service unavailable. Please try again later." };
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

    await ctx.emit({
      kind: "chat",
      parseMode: "Markdown",
      text: buildWithdrawQuoteSummary(displayMeta, plan.txSteps.length),
    });

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

    return {
      kind: "chat",
      parseMode: "Markdown",
      text: buildWithdrawSuccessMessage(result.txHashes),
    };
  }

  private async executeSignSteps(opts: {
    ctx: CapabilityCtx;
    steps: TxStep[];
    labelPrefix: string;
    kind: SignKind;
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
          artifact: { kind: "chat", text: `${labelPrefix} aborted at step ${i + 1}/${steps.length}.` },
        };
      }
      if (resolution.status === "expired") {
        return {
          aborted: true,
          artifact: { kind: "chat", text: `${labelPrefix} timed out at step ${i + 1}/${steps.length}.` },
        };
      }
      if (resolution.txHash) {
        txHashes.push(resolution.txHash);
      }
    }

    return { aborted: false, txHashes };
  }

  private handleCallback(
    _ctx: CapabilityCtx,
    data: string,
  ): CollectResult<{ pct: number } | { withdraw: true }> {
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

function buildDepositQuoteSummary(
  plan: { protocolId: string; chainId: number },
  meta: YieldDisplayMeta | undefined,
  stepCount: number,
): string {
  const lines = ["*Yield deposit quote*", ""];
  if (meta) {
    lines.push(`Deposit: ${meta.amountHuman} *${meta.tokenSymbol}*`);
    lines.push(`Protocol: ${meta.protocolName} (chain ${plan.chainId})`);
    if (meta.expectedApy != null) {
      lines.push(`APY: ~${(meta.expectedApy * 100).toFixed(2)}%`);
    }
  } else {
    lines.push(`Protocol: ${plan.protocolId} (chain ${plan.chainId})`);
  }
  lines.push(`Steps: ${stepCount}`);
  lines.push("");
  lines.push(
    stepCount === 1
      ? "Tap the button below to execute the deposit automatically."
      : "Tap the button below — all steps will be signed in one mini-app session.",
  );
  return lines.join("\n");
}

function buildWithdrawQuoteSummary(
  meta: YieldDisplayMeta | undefined,
  stepCount: number,
): string {
  const lines = ["*Yield withdrawal quote*", ""];
  if (meta) {
    lines.push(`Withdraw: ${meta.amountHuman} *${meta.tokenSymbol}*`);
    lines.push(`Protocol: ${meta.protocolName}`);
  }
  lines.push(`Steps: ${stepCount}`);
  lines.push("");
  lines.push(
    stepCount === 1
      ? "Tap the button below to execute the withdrawal automatically."
      : "Tap the button below — all steps will be signed in one mini-app session.",
  );
  return lines.join("\n");
}

function buildDepositSuccessMessage(pct: number, txHashes: string[]): string {
  const lines = [
    `*Yield deposit complete* (${pct}% of idle USDC)`,
    "",
    "*Transaction hashes*",
    ...txHashes.map((h, i) => `${i + 1}. \`${h}\``),
    "",
    "Your USDC is now earning yield on Aave v3. Use /withdraw to exit at any time.",
  ];
  return lines.join("\n");
}

function buildWithdrawSuccessMessage(txHashes: string[]): string {
  const lines = [
    "*Withdrawal complete*",
    "",
    "*Transaction hashes*",
    ...txHashes.map((h, i) => `${i + 1}. \`${h}\``),
  ];
  return lines.join("\n");
}
