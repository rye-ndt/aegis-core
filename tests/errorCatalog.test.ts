/**
 * Unit tests for the BE error catalog (`helpers/errors/errorCatalog.ts`).
 * Covers the regex pattern table, the typed-instance fast path
 * (`UnsupportedChainError`), and the default fallback.
 *
 * Run with: npx tsx --test tests/errorCatalog.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { interpretError } from "../src/helpers/errors/errorCatalog";
import { UnsupportedChainError } from "../src/helpers/errors/unsupportedChainError";

const CTX = { verb: "swap" as const, requestId: "req-1234" };

test("amount_too_low matches AMOUNT_TOO_LOW", () => {
  const out = interpretError(new Error("AMOUNT_TOO_LOW: bridge minimum"), CTX);
  assert.equal(out.code, "amount_too_low");
  assert.match(out.friendly, /too small/i);
  assert.equal(out.requestId, "req-1234");
});

test("no_route matches RELAY_QUOTE_FAILED", () => {
  const out = interpretError(new Error("RELAY_QUOTE_FAILED upstream"), CTX);
  assert.equal(out.code, "no_route");
});

test("no_liquidity preempts no_route when both could match", () => {
  const out = interpretError(new Error("NO_LIQUIDITY for that route"), CTX);
  assert.equal(out.code, "no_liquidity");
});

test("insufficient_balance carries a /buy recovery", () => {
  const out = interpretError(
    new Error("transfer amount exceeds balance"),
    CTX,
  );
  assert.equal(out.code, "insufficient_balance");
  assert.deepEqual(out.recovery, {
    label: "Top up",
    kind: "command",
    payload: "/buy",
  });
});

test("insufficient_gas matches AA21", () => {
  const out = interpretError(new Error("UserOperation reverted: AA21 didn't pay prefund"), CTX);
  assert.equal(out.code, "insufficient_gas");
  assert.equal(out.recovery?.payload, "/buy");
});

test("rate_limited matches 429", () => {
  const out = interpretError(new Error("HTTP 429 Too Many Requests"), CTX);
  assert.equal(out.code, "rate_limited");
});

test("service_unavailable matches ECONNREFUSED", () => {
  const out = interpretError(new Error("connect ECONNREFUSED 127.0.0.1:443"), CTX);
  assert.equal(out.code, "service_unavailable");
});

test("UnsupportedChainError uses instance check, not regex", () => {
  const err = new UnsupportedChainError(99999);
  const out = interpretError(err, CTX);
  assert.equal(out.code, "unsupported_chain");
  assert.match(out.friendly, /isn't supported/i);
});

test("recipient_unresolved matches recipient.*not.*resolved", () => {
  const out = interpretError(new Error("recipient could not be resolved"), CTX);
  assert.equal(out.code, "recipient_unresolved");
});

test("stock_market_closed matches MARKET_CLOSED", () => {
  const out = interpretError(new Error("MARKET_CLOSED"), CTX);
  assert.equal(out.code, "stock_market_closed");
});

test("yield_winner_changed matches winner changed", () => {
  const out = interpretError(new Error("winner changed before submit"), CTX);
  assert.equal(out.code, "yield_winner_changed");
});

test("default fallback is internal", () => {
  const out = interpretError(new Error("totally unknown weird thing"), CTX);
  assert.equal(out.code, "internal");
  assert.match(out.friendly, /something went wrong/i);
});

test("never returns code or raw inside friendly", () => {
  const out = interpretError(new Error("AA21 prefund failed"), CTX);
  assert.doesNotMatch(out.friendly, /AA21/);
  assert.doesNotMatch(out.friendly, /insufficient_gas/);
});

test("requestId is always echoed", () => {
  const a = interpretError(new Error("anything"), { verb: "send", requestId: "abc" });
  assert.equal(a.requestId, "abc");
});

test("unsupported_token matches UNKNOWN_TOKEN", () => {
  const out = interpretError(new Error("UNKNOWN_TOKEN: foo"), CTX);
  assert.equal(out.code, "unsupported_token");
});

test("insufficient_allowance matches ERC20 allowance error", () => {
  const out = interpretError(new Error("ERC20: insufficient allowance"), CTX);
  assert.equal(out.code, "insufficient_allowance");
  assert.equal(out.recovery?.payload, "/permissions");
});

test("transfer_history_unavailable matches history-unavailable on chain", () => {
  const out = interpretError(new Error("transfer history unavailable on this chain"), CTX);
  assert.equal(out.code, "transfer_history_unavailable");
});

test("delegation_required and delegation_exceeded are distinct", () => {
  const required = interpretError(new Error("delegation required for token"), CTX);
  const exceeded = interpretError(new Error("delegation spend limit exceeded"), CTX);
  assert.equal(required.code, "delegation_required");
  assert.equal(exceeded.code, "delegation_exceeded");
});
