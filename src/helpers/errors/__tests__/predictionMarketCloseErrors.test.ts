/**
 * Run with:
 *   npx tsx --test src/helpers/errors/__tests__/predictionMarketCloseErrors.test.ts
 *
 * Locks the wire-level mapping shared by `ClosePositionCapability` and the
 * mini-app HTTP route. Adding a new domain code = add a case here + a
 * branch in the switch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { humanizeCloseError } from "../predictionMarketCloseErrors";

test("POSITION_NOT_FOUND → 404 with stable code", () => {
  const m = humanizeCloseError(new Error("POSITION_NOT_FOUND"));
  assert.equal(m.httpStatus, 404);
  assert.equal(m.code, "POSITION_NOT_FOUND");
  assert.match(m.message, /no longer exists/i);
});

test("POSITION_WRONG_STATUS → 409", () => {
  const m = humanizeCloseError(new Error("POSITION_WRONG_STATUS"));
  assert.equal(m.httpStatus, 409);
  assert.equal(m.code, "POSITION_WRONG_STATUS");
  assert.match(m.message, /open for closing/i);
});

test("BET_IN_FLIGHT → 409", () => {
  const m = humanizeCloseError(new Error("BET_IN_FLIGHT"));
  assert.equal(m.httpStatus, 409);
  assert.equal(m.code, "BET_IN_FLIGHT");
  assert.match(m.message, /bet being placed/i);
});

test("error message with colon-suffixed detail still parses the code", () => {
  // `initiateClose` callers throw `Error("POSITION_WRONG_STATUS: was closing")`
  // — the helper must strip the suffix to match the case.
  const m = humanizeCloseError(new Error("POSITION_WRONG_STATUS: was closing"));
  assert.equal(m.httpStatus, 409);
  assert.equal(m.code, "POSITION_WRONG_STATUS");
});

test("unknown error → 500 INTERNAL with generic message", () => {
  const m = humanizeCloseError(new Error("SOMETHING_ELSE"));
  assert.equal(m.httpStatus, 500);
  assert.equal(m.code, "INTERNAL");
  assert.match(m.message, /try again/i);
});

test("non-Error throwable → 500 INTERNAL", () => {
  assert.equal(humanizeCloseError("string-throw").httpStatus, 500);
  assert.equal(humanizeCloseError(null).code, "INTERNAL");
  assert.equal(humanizeCloseError(undefined).code, "INTERNAL");
  assert.equal(humanizeCloseError({ random: "object" }).code, "INTERNAL");
});
