import { z } from "zod";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { ICapabilityDispatcher } from "../../../../use-cases/interface/input/capabilityDispatcher.interface";

const log = createLogger("stockOpenTool");

const InputSchema = z.object({
  side: z
    .enum(["buy", "short"])
    .describe("'buy' opens a long position, 'short' opens a short position."),
  symbol: z
    .string()
    .regex(/^[A-Za-z]{1,5}$/, "1–5 letter ticker, e.g. AAPL")
    .describe("Stock ticker. Supported: AAPL, AMZN, TSLA, NVDA, GOOG, META."),
  amountUsd: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "Decimal USD amount, e.g. '10' or '12.5'")
    .describe(
      "Notional collateral in USD. Funded from the user's home-chain USDC balance.",
    ),
});

export interface StockOpenToolDeps {
  userId: string;
  channelId: string;
  dispatcher: ICapabilityDispatcher;
  /** Soft-disable gate flipped when verifyStockCapability() fails at boot. */
  isDisabled: () => boolean;
}

export class StockOpenTool implements ITool {
  constructor(private readonly deps: StockOpenToolDeps) {}

  definition(): IToolDefinition {
    return {
      name: "stock_open",
      description:
        "Open a tokenized-stock position (long or short) on Aster (BSC). " +
        "Use this for ANY user request to buy, long, or short a stock — including " +
        "phrasings like 'buy AAPL', 'buy $10 of TSLA', 'I want some Apple shares'. " +
        "Do NOT use `route_intent` with `command=\"/buy\"` for stock symbols — " +
        "`/buy` is the USDC fiat-onramp and is the wrong tool for stocks. " +
        "Supported symbols: AAPL, AMZN, TSLA, NVDA, GOOG, META. " +
        "The user is shown a mini-app confirmation modal before any signing — " +
        "this tool does NOT execute silently. " +
        "For closing or setting SL/TP, instruct the user to use /stock close, " +
        "/stock sl, or /stock tp.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    if (this.deps.isDisabled()) {
      log.warn(
        { step: "failed", userId: this.deps.userId, reason: "stocks-disabled" },
        "stock-open rejected — capability soft-disabled",
      );
      return {
        success: false,
        error: "Stock trading is temporarily unavailable. Please try again later.",
      };
    }

    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      log.warn(
        { step: "failed", userId: this.deps.userId, reason: "schema-parse-failed" },
        "stock-open input rejected",
      );
      return {
        success: false,
        error: `Invalid stock_open arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }

    const { side, symbol, amountUsd } = parsed.data;
    const text = `/stock ${side} $${amountUsd} ${symbol.toUpperCase()}`;

    log.info(
      { step: "started", userId: this.deps.userId, side, symbol: symbol.toUpperCase(), amountUsd },
      "stock-open dispatching to /stock capability",
    );

    try {
      const result = await this.deps.dispatcher.handle({
        userId: this.deps.userId,
        channelId: this.deps.channelId,
        input: { kind: "text", text },
      });
      log.info(
        { step: "succeeded", userId: this.deps.userId, handled: result.handled },
        "stock-open dispatch returned",
      );
      // The dispatcher already rendered the user-facing artifact (mini-app modal,
      // success/failure card, etc.) via the renderer. The string we return here
      // only goes back to the LLM as the tool result — keep it short so the
      // model writes a concise closing reply instead of paraphrasing.
      return {
        success: true,
        data: result.handled
          ? `Stock ${side} flow started for $${amountUsd} ${symbol.toUpperCase()} — the user has been shown a confirmation modal.`
          : `Could not start the ${side} flow for ${symbol.toUpperCase()}.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, userId: this.deps.userId, side, symbol },
        "stock-open dispatch threw",
      );
      return { success: false, error: msg };
    }
  }
}
