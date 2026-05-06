import { z } from "zod";
import { createLogger } from "../../../../helpers/observability/logger";
import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { ICapabilityDispatcher } from "../../../../use-cases/interface/input/capabilityDispatcher.interface";

const log = createLogger("routeIntentTool");

// Subset of INTENT_COMMAND that maps to a registered capability driven by
// user intent (on-chain action or money UX). Every value here MUST resolve
// to a capability at registry-match time — otherwise the recursive
// dispatcher falls back to the default LLM capability and could re-invoke
// `route_intent`, burning tool rounds. Read-only commands (/points,
// /leaderboard, /positions) and dispatcher-unbound commands (/withdraw —
// historically routed via the /yield UI buttons, never as a top-level
// trigger) stay out.
const COMMAND_VALUES = [
  INTENT_COMMAND.SWAP,
  INTENT_COMMAND.SEND,
  INTENT_COMMAND.BUY,
  INTENT_COMMAND.SELL,
  INTENT_COMMAND.CONVERT,
  INTENT_COMMAND.TOPUP,
  INTENT_COMMAND.DCA,
  INTENT_COMMAND.YIELD,
  INTENT_COMMAND.STOCK,
  INTENT_COMMAND.MONEY,
] as const;

const InputSchema = z.object({
  command: z
    .enum(COMMAND_VALUES)
    .describe(
      "Slash command for the matching capability. Pick the most specific one. " +
        "`/buy` is the USDC fiat onramp (deposit address or card payment) — use it " +
        "when the user wants to fund/add money to/deposit into their account from " +
        "fiat; never use it for stock symbols (use the `stock_open` tool for stocks). " +
        "`/topup` is for crypto-to-USDC top-up of the account. " +
        "`/yield` is ONLY for earn/yield/APY flows — pick it only when the user " +
        "explicitly mentions yield, earn, APY, interest, or optimizing idle USDC. " +
        "Generic phrases like \"fund the account\", \"add funds\", \"deposit money\" " +
        "are NOT yield — they are `/buy` (fiat) or `/topup` (crypto).",
    ),
  rest: z
    .string()
    .max(512)
    .default("")
    .describe(
      "Natural-language remainder of the user's request, verbatim — e.g. for 'swap 0.8 USDT to USDC', pass '0.8 USDT to USDC'. Empty string is OK if the user only stated the verb.",
    ),
});

export interface RouteIntentToolDeps {
  userId: string;
  channelId: string;
  conversationId: string;
  dispatcher: ICapabilityDispatcher;
}

/**
 * Single LLM-facing tool that funnels every natural-language on-chain intent
 * back through the slash-command capability dispatcher. Replaces the legacy
 * `execute_intent` + per-verb shims (transferErc20Tool, etc.). The dispatcher
 * already knows how to resume a stale pending collection, render mini-app
 * artifacts, and emit result_cards — re-entering it gives `swap`-the-NL the
 * exact same code path as `/swap`.
 */
export class RouteIntentTool implements ITool {
  constructor(private readonly deps: RouteIntentToolDeps) {}

  definition(): IToolDefinition {
    return {
      name: "route_intent",
      description:
        "Route the user's natural-language on-chain or money request to the matching capability. " +
        "Call this for any request to swap, send, buy, sell, convert, top up, DCA, deposit/withdraw " +
        "yield, or buy/short/close a stock. Pass the user's verbatim remainder as `rest`. " +
        "Do NOT call this for read-only questions (balances, positions, prices, history) — those " +
        "have dedicated tools. The capability layer renders the user-facing UI; you only need to " +
        "write a brief closing acknowledgement after this returns. " +
        "When `command=\"/buy\"` is the candidate but the user's text mentions a stock " +
        "symbol (AAPL, TSLA, NVDA, GOOG, META, AMZN, etc.) or words like \"stock\"/\"shares\", " +
        "call `stock_open` instead — `/buy` is for the USDC fiat onramp only.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      log.warn(
        { step: "failed", userId: this.deps.userId, reason: "schema-parse-failed" },
        "route_intent input rejected",
      );
      return {
        success: false,
        error: `Invalid route_intent arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }

    const { command, rest } = parsed.data;
    const text = rest.trim() ? `${command} ${rest.trim()}` : command;

    log.info(
      { step: "started", userId: this.deps.userId, command, hasRest: !!rest.trim() },
      "route_intent dispatching",
    );

    try {
      const result = await this.deps.dispatcher.handle({
        userId: this.deps.userId,
        channelId: this.deps.channelId,
        conversationId: this.deps.conversationId,
        input: { kind: "text", text },
      });
      log.info(
        { step: "succeeded", userId: this.deps.userId, command, handled: result.handled },
        "route_intent dispatch returned",
      );
      // The dispatcher already rendered the user-facing artifact. Tell the
      // LLM explicitly NOT to write a follow-up — historically a "flow
      // started" sentence here leaked into Telegram before the user had
      // tapped the mini-app button (or chose not to), which read as a false
      // confirmation. The system prompt also instructs an empty reply on
      // success; this is the matching tool-side signal.
      return {
        success: true,
        data: result.handled
          ? "Capability rendered the user's next step. Reply with an empty string — do not write any follow-up."
          : `Could not start the ${command} flow.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, userId: this.deps.userId, command },
        "route_intent dispatch threw",
      );
      return { success: false, error: msg };
    }
  }
}
