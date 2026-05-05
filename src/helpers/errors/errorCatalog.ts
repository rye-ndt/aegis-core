import { createLogger } from "../observability/logger";
import { toErrorMessage } from "./toErrorMessage";
import { UnsupportedChainError } from "./unsupportedChainError";
import type { IntentVerb } from "../../use-cases/interface/input/resultCard.types";

const log = createLogger("errorCatalog");

export type ErrorCode =
  | "amount_too_low"
  | "amount_too_high"
  | "no_route"
  | "no_liquidity"
  | "insufficient_balance"
  | "insufficient_gas"
  | "insufficient_allowance"
  | "rate_limited"
  | "service_unavailable"
  | "unsupported_chain"
  | "unsupported_token"
  | "recipient_unresolved"
  | "delegation_required"
  | "delegation_exceeded"
  | "stock_market_closed"
  | "stock_oracle_stale"
  | "stock_min_size"
  | "stock_pair_inactive"
  | "yield_winner_changed"
  | "yield_position_vanished"
  | "transfer_history_unavailable"
  | "internal";

export interface InterpretedErrorRecovery {
  label: string;
  kind: "command" | "callback";
  payload: string;
}

export interface InterpretedError {
  code: ErrorCode;
  friendly: string;
  recovery?: InterpretedErrorRecovery;
  raw: string;
  requestId: string;
}

interface PatternEntry {
  pattern: RegExp;
  code: ErrorCode;
  friendly: string;
  recovery?: InterpretedErrorRecovery;
}

// TODO(i18n): all `friendly` strings here are English-only.
const PATTERNS: PatternEntry[] = [
  {
    pattern: /AMOUNT_TOO_LOW|amount is too small/i,
    code: "amount_too_low",
    friendly: "That amount is too small for this route. Try at least $1.",
  },
  {
    pattern: /AMOUNT_TOO_HIGH|exceeds.*max/i,
    code: "amount_too_high",
    friendly: "That amount is too large for this route. Try a smaller amount.",
  },
  {
    pattern: /NO_LIQUIDITY/i,
    code: "no_liquidity",
    friendly:
      "There isn't enough liquidity for this swap right now. Try a smaller amount or a different token.",
  },
  {
    pattern: /NO_ROUTE|route not found|RELAY_QUOTE_FAILED/i,
    code: "no_route",
    friendly: "Couldn't find a route right now. Please try again in a moment.",
  },
  {
    pattern: /insufficient.*balance|transfer amount exceeds balance/i,
    code: "insufficient_balance",
    friendly: "You don't have enough of that token to do that. Tap below to top up.",
    recovery: { label: "Top up", kind: "command", payload: "/buy" },
  },
  {
    pattern: /AA21|prefund/i,
    code: "insufficient_gas",
    friendly: "Your account is low on gas. Top up to continue.",
    recovery: { label: "Top up", kind: "command", payload: "/buy" },
  },
  {
    pattern: /delegation.*required|no token delegation/i,
    code: "delegation_required",
    friendly: "You need to grant Aegis permission to spend this token first.",
  },
  {
    pattern: /delegation.*exceeded|spend.*limit/i,
    code: "delegation_exceeded",
    friendly:
      "You've reached your spending limit for this token. Raise it to continue.",
    recovery: { label: "Raise limit", kind: "command", payload: "/permissions" },
  },
  {
    pattern: /\b429\b|rate.?limit/i,
    code: "rate_limited",
    friendly: "Things are busy right now. Please try again in a moment.",
  },
  {
    pattern: /unsupported.*token|token.*not.*supported|UNKNOWN_TOKEN/i,
    code: "unsupported_token",
    friendly: "That token isn't supported on this chain yet.",
  },
  {
    pattern: /insufficient.*allowance|ERC20:.*allowance/i,
    code: "insufficient_allowance",
    friendly: "You need to approve Aegis to spend that token before continuing.",
    recovery: { label: "Grant permission", kind: "command", payload: "/permissions" },
  },
  {
    pattern: /transfer.?history.*unavailable|history.*unavailable.*chain/i,
    code: "transfer_history_unavailable",
    friendly: "Transfer history isn't available on this chain right now.",
  },
  {
    pattern: /\b503\b|service unavailable|ECONNREFUSED/i,
    code: "service_unavailable",
    friendly: "The service is briefly unavailable. Please try again in a moment.",
  },
  {
    pattern: /recipient.*not.*resolved|unknown.*handle/i,
    code: "recipient_unresolved",
    friendly: "Couldn't find that recipient. Double-check the @handle or wallet address.",
  },
  {
    pattern: /MARKET_CLOSED|outside.*trading hours/i,
    code: "stock_market_closed",
    friendly: "US markets are closed right now. Try again when they reopen.",
  },
  {
    pattern: /STALE_PRICE|oracle.*stale/i,
    code: "stock_oracle_stale",
    friendly: "The stock price feed is briefly stale. Try again in a moment.",
  },
  {
    pattern: /MIN_TRADE_SIZE|below.*minimum/i,
    code: "stock_min_size",
    friendly: "That trade is below the minimum size. Try a larger amount.",
  },
  {
    pattern: /PAIR_INACTIVE/i,
    code: "stock_pair_inactive",
    friendly: "That stock isn't tradable right now.",
  },
  {
    pattern: /winner.*changed/i,
    code: "yield_winner_changed",
    friendly: "The best pool changed before we could rebalance — no action taken.",
  },
  {
    pattern: /position.*not.*found/i,
    code: "yield_position_vanished",
    friendly: "Looks like you already withdrew — nothing to rebalance.",
  },
];

export function interpretError(
  err: unknown,
  ctx: { verb: IntentVerb; requestId: string },
): InterpretedError {
  const raw = toErrorMessage(err);

  // Instance-checks come first — UnsupportedChainError is a typed sentinel
  // and may not always carry a matching message.
  if (err instanceof UnsupportedChainError) {
    const out: InterpretedError = {
      code: "unsupported_chain",
      friendly: "That chain isn't supported yet.",
      raw,
      requestId: ctx.requestId,
    };
    log.error(
      { err: raw, code: out.code, requestId: ctx.requestId, verb: ctx.verb },
      "interpret-error",
    );
    return out;
  }

  for (const entry of PATTERNS) {
    if (entry.pattern.test(raw)) {
      const out: InterpretedError = {
        code: entry.code,
        friendly: entry.friendly,
        recovery: entry.recovery,
        raw,
        requestId: ctx.requestId,
      };
      log.error(
        { err: raw, code: out.code, requestId: ctx.requestId, verb: ctx.verb },
        "interpret-error",
      );
      return out;
    }
  }

  const fallback: InterpretedError = {
    code: "internal",
    friendly: "Something went wrong on our side. Please try again.",
    raw,
    requestId: ctx.requestId,
  };
  log.error(
    { err: raw, code: fallback.code, requestId: ctx.requestId, verb: ctx.verb },
    "interpret-error",
  );
  return fallback;
}
