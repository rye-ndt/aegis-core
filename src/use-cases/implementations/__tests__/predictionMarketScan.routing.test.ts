/**
 * Run with:
 *   npx tsx --test src/use-cases/implementations/__tests__/predictionMarketScan.routing.test.ts
 *
 * Enforces the Part 7 invariant: the routing fn must never return the LLM
 * detector for a subject in `cutOverSubjects`. If a future change re-introduces
 * the LLM in a cut-over hot path, CI breaks here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { pickDetector } from "../predictionMarketScan.usecase";
import type { IPredictionMarketDetector } from "../../interface/predictionMarket/IPredictionMarketDetector";

const llm: IPredictionMarketDetector = { detect: async () => [] };
const det: IPredictionMarketDetector = { detect: async () => [] };

test("routing: cut-over subject routes to deterministic detector", () => {
  const result = pickDetector(
    { derivedSubject: "BTC_USD_SPOT" },
    new Set(["BTC_USD_SPOT"]),
    llm,
    det,
  );
  assert.equal(result, det);
});

test("routing: non-cut-over subject routes to LLM", () => {
  const result = pickDetector(
    { derivedSubject: "ETH_USD_SPOT" },
    new Set(["BTC_USD_SPOT"]),
    llm,
    det,
  );
  assert.equal(result, llm);
});

test("routing: null derivedSubject (LLM-clustered) routes to LLM", () => {
  const result = pickDetector(
    { derivedSubject: null },
    new Set(["BTC_USD_SPOT"]),
    llm,
    det,
  );
  assert.equal(result, llm);
});

test("routing: undefined derivedSubject routes to LLM", () => {
  const result = pickDetector(
    {},
    new Set(["BTC_USD_SPOT"]),
    llm,
    det,
  );
  assert.equal(result, llm);
});

test("routing: cut-over subject with no deterministic detector falls back to LLM (legacy bootstrap)", () => {
  const result = pickDetector(
    { derivedSubject: "BTC_USD_SPOT" },
    new Set(["BTC_USD_SPOT"]),
    llm,
    null,
  );
  assert.equal(result, llm);
});

test("routing: empty cut-over set never picks deterministic detector", () => {
  for (const subject of ["BTC_USD_SPOT", "ETH_USD_SPOT", null]) {
    const result = pickDetector(
      { derivedSubject: subject },
      new Set(),
      llm,
      det,
    );
    assert.equal(result, llm);
  }
});

// Property-style invariant: the Part 7 cross-cutting rule.
test("invariant: pickDetector never returns LLM for a cut-over subject when deterministic is available", () => {
  const cutOver = new Set(["BTC_USD_SPOT", "ETH_USD_SPOT", "FED_FUNDS_RATE"]);
  for (const subject of cutOver) {
    const result = pickDetector({ derivedSubject: subject }, cutOver, llm, det);
    assert.notEqual(result, llm, `LLM leaked into cut-over subject ${subject}`);
    assert.equal(result, det);
  }
});
