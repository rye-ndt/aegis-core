import { InlineKeyboard } from "grammy";
import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { OnrampRequest } from "../../../../use-cases/interface/output/cache/miniAppRequest.types";
import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import { CHAIN_CONFIG } from "../../../../helpers/chainConfig";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";

type BuyParams =
  | { choice: "deposit" | "card"; amount: number }
  | { choice: "copy"; address: string };

type BuyState =
  | { stage: "awaiting_amount" }
  | { stage: "awaiting_choice"; amount: number };

/**
 * /buy <amount?> → asks for amount if missing → asks yes/no → emits either
 * a chat artifact with the deposit address or an onramp mini-app artifact.
 *
 * All /buy state lives in this file. No LLM involvement — the yes/no is a
 * two-button inline keyboard and the amount is a regex.
 */
export class BuyCapability implements Capability<BuyParams> {
  readonly id = "buy";
  readonly triggers: TriggerSpec = {
    command: INTENT_COMMAND.BUY,
    callbackPrefix: "buy",
  };

  constructor(
    private readonly userProfileRepo: IUserProfileDB,
    private readonly chainId: number = CHAIN_CONFIG.chainId,
  ) {}

  async collect(
    ctx: CapabilityCtx,
    resuming?: Record<string, unknown>,
  ): Promise<CollectResult<BuyParams>> {
    const state = resuming as BuyState | undefined;

    // ── Callback (yes/no/copy) ─────────────────────────────────────────
    if (ctx.input.kind === "callback") {
      const data = ctx.input.data;
      const match = data.match(/^buy:(y|n|copy):(.+)$/);
      if (!match) return this.restart();
      const kind = match[1]!;
      const payload = match[2]!;

      if (kind === "copy") {
        return { kind: "ok", params: { choice: "copy", address: payload } };
      }
      const amount = parseBuyAmount(payload);
      if (amount === null) return this.restart();
      return {
        kind: "ok",
        params: { amount, choice: kind === "y" ? "deposit" : "card" },
      };
    }

    // ── Text ───────────────────────────────────────────────────────────
    const text = ctx.input.text;

    // Resuming an "awaiting_amount" prompt with a bare number.
    if (state?.stage === "awaiting_amount") {
      const amount = parseBuyAmount(text);
      if (amount === null) {
        return {
          kind: "ask",
          question: "Please enter a valid USDC amount, e.g. `50`.",
          parseMode: "Markdown",
          state: { stage: "awaiting_amount" },
        };
      }
      return this.askChoice(amount);
    }

    // Fresh /buy entry.
    const rest = text.replace(/^\/buy\b/i, "").trim();
    if (rest.length === 0) {
      return {
        kind: "ask",
        question: "How much USDC would you like to buy? Reply with a number, e.g. `50`.",
        parseMode: "Markdown",
        state: { stage: "awaiting_amount" },
      };
    }
    const amount = parseBuyAmount(rest);
    if (amount === null) {
      return {
        kind: "ask",
        question: "Please provide a valid amount, e.g. `/buy 50`.",
        parseMode: "Markdown",
        state: { stage: "awaiting_amount" },
      };
    }
    return this.askChoice(amount);
  }

  async run(params: BuyParams, ctx: CapabilityCtx): Promise<Artifact> {
    if (params.choice === "copy") {
      return { kind: "chat", text: `\`${params.address}\``, parseMode: "Markdown" };
    }

    const profile = await this.userProfileRepo.findByUserId(ctx.userId);
    const address = profile?.smartAccountAddress;
    if (!address) {
      return {
        kind: "chat",
        text: "Your smart account address is not set up yet. Open the Aegis mini app once to initialise it.",
      };
    }

    const amountStr = formatBuyAmount(params.amount);

    if (params.choice === "deposit") {
      const keyboard = new InlineKeyboard().text("Copy address", `buy:copy:${address}`);
      return {
        kind: "chat",
        parseMode: "Markdown",
        keyboard,
        text:
          `Deposit *${amountStr} USDC* on *${CHAIN_CONFIG.name}* to:\n` +
          `\`${address}\`\n\n` +
          `Send only USDC on ${CHAIN_CONFIG.name} — other networks or tokens will be lost.`,
      };
    }

    // card → mini-app onramp
    const now = newCurrentUTCEpoch();
    const request: OnrampRequest = {
      requestId: newUuid(),
      requestType: "onramp",
      userId: ctx.userId,
      amount: params.amount,
      asset: "USDC",
      chainId: this.chainId,
      walletAddress: address,
      createdAt: now,
      expiresAt: now + 600,
    };
    return {
      kind: "mini_app",
      request,
      promptText: `Tap below to buy ${amountStr} USDC with card or Apple Pay.`,
      buttonText: "Buy USDC with card",
      fallbackText: "Onramp is not configured on this server.",
    };
  }

  private askChoice(amount: number): CollectResult<BuyParams> {
    const amountStr = formatBuyAmount(amount);
    const keyboard = new InlineKeyboard()
      .text("Yes, I'll deposit", `buy:y:${amountStr}`)
      .text("No, buy with card", `buy:n:${amountStr}`);
    return {
      kind: "ask",
      parseMode: "Markdown",
      keyboard,
      question: `Buying *${amountStr}* USDC.\n\nDo you already have crypto in a wallet like Binance or Rabby?`,
      state: { stage: "awaiting_choice", amount },
    };
  }

  private restart(): CollectResult<BuyParams> {
    return {
      kind: "ask",
      question: "Session expired — please start again with `/buy <amount>`.",
      parseMode: "Markdown",
      state: { stage: "awaiting_amount" },
    };
  }
}

function parseBuyAmount(text: string): number | null {
  const match = text.trim().match(/^\$?(\d+(?:\.\d+)?)\s*(?:usdc)?$/i);
  if (!match) return null;
  const value = parseFloat(match[1]!);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function formatBuyAmount(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toString();
}
