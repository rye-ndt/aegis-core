import { InlineKeyboard } from "grammy";
import { CHAIN_CONFIG } from "../../../../helpers/chainConfig";
import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import { createLogger } from "../../../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type { IntentResult } from "../../../../use-cases/interface/input/resultCard.types";
import type { OnrampRequest } from "../../../../use-cases/interface/output/cache/miniAppRequest.types";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { IStockPairRegistry } from "../../../../use-cases/interface/output/stocks/stockPair.interface";

const log = createLogger("buyCapability");

type BuyParams = { choice: "deposit" | "card"; amount: number };

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
    /**
     * Optional — when present, `/buy <stockSymbol>` is intercepted and the
     * user is redirected to `/stock buy …` instead of being dropped into the
     * USDC onramp flow. Skipped silently when the catalogue is empty so a
     * stalled crawler never blocks the onramp. See plan §P0.3.
     */
    private readonly stockPairRegistry?: IStockPairRegistry,
  ) {}

  async collect(
    ctx: CapabilityCtx,
    resuming?: Record<string, unknown>,
  ): Promise<CollectResult<BuyParams>> {
    const state = resuming as BuyState | undefined;

    // ── Callback (yes/no/copy) ─────────────────────────────────────────
    if (ctx.input.kind === "callback") {
      const data = ctx.input.data;
      const match = data.match(/^buy:(y|n):(.+)$/);
      if (!match) return this.restart();
      const kind = match[1]!;
      const payload = match[2]!;

      const amount = parseBuyAmount(payload);
      if (amount === null) return this.restart();
      return {
        kind: "ok",
        params: { amount, choice: kind === "y" ? "deposit" : "card" },
      };
    }

    // ── Text ───────────────────────────────────────────────────────────
    const text = ctx.input.text;

    // §P0.3 reroute — if the user typed `/buy AAPL` (or "100 AAPL" while
    // resuming an awaiting_amount prompt), the right capability is /stock,
    // not the USDC onramp. Skip silently when the catalogue isn't loaded so
    // an offline stock crawler never blocks the onramp.
    if (this.stockPairRegistry && this.stockPairRegistry.symbols().length > 0) {
      const stripped = text.replace(/^\/buy\b/i, "").trim();
      const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);
      let parsedAmount: string | undefined;
      let stockSymbol: string | undefined;
      for (const tok of tokens) {
        const cleanedAmt = tok.replace(/^\$/, "");
        if (!parsedAmount && /^\d+(?:\.\d+)?$/.test(cleanedAmt)) {
          parsedAmount = cleanedAmt;
          continue;
        }
        if (!stockSymbol) {
          const resolved = this.stockPairRegistry.resolveByQuery(tok);
          if (resolved) stockSymbol = resolved.symbol;
        }
      }
      if (stockSymbol) {
        log.info(
          { step: "rerouted-to-stock", symbol: stockSymbol },
          "/buy <stock> rerouted",
        );
        const amountForExample = parsedAmount ?? "100";
        const buttonLabel = `Buy ${amountForExample} USD of ${stockSymbol} stock`;
        const keyboard = new InlineKeyboard().text(
          buttonLabel,
          `stock:reroute:${stockSymbol}`,
        );
        const message =
          `You typed \`/buy ${stockSymbol}\`, which is for buying USDC ` +
          `(the dollar stablecoin). Did you mean to buy a stock? ` +
          `Try \`/stock buy $${amountForExample} ${stockSymbol}\`.`;
        return {
          kind: "terminal",
          artifact: {
            kind: "chat",
            text: message,
            parseMode: "Markdown",
            keyboard,
          },
        };
      }
    }

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
        question:
          "How much USDC would you like to buy? Reply with a number, e.g. `50`.",
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
    const profile = await this.userProfileRepo.findByUserId(ctx.userId);
    const address = profile?.smartAccountAddress;
    if (!address) {
      const failed: IntentResult = {
        status: "failed",
        verb: "buy_onramp",
        headline: "Wallet not set up yet",
        fields: [
          {
            label: "Reason",
            value:
              "Your smart account address is not set up yet. Open the Aegis mini app once to initialise it.",
          },
        ],
        complexity: "simple",
      };
      return { kind: "result_card", result: failed };
    }

    const amountStr = formatBuyAmount(params.amount);

    if (params.choice === "deposit") {
      const result: IntentResult = {
        status: "pending",
        verb: "buy_onramp",
        headline: `Deposit ${amountStr} USDC on ${CHAIN_CONFIG.name}`,
        fields: [
          { label: "Amount", value: `${amountStr} USDC`, emphasis: "primary" },
          { label: "Network", value: CHAIN_CONFIG.name },
          { label: "To address", value: address },
        ],
        nextActions: [
          { label: "Buy with card instead", kind: "callback", payload: `buy:n:${amountStr}` },
        ],
        complexity: "simple",
      };
      return { kind: "result_card", result };
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
