/**
 * Unit tests for the EMA smoothing in `yieldPoolRanker`.
 * Run with: npx tsx --test tests/yieldPoolRanker.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEma } from "../src/use-cases/implementations/yieldPoolRanker";

test("EMA on a flat series returns the constant", () => {
  const ema = computeEma([5, 5, 5, 5, 5]);
  assert.ok(Math.abs(ema - 5) < 1e-9);
});

test("EMA differs from plain mean and leans toward the most-recent sample", () => {
  // Plan's series — newest-first storage means index 0 (=5) is the newest.
  // Plain mean = (5+5+5+5+100)/5 = 24. EMA should be < 24, leaning toward 5.
  const series = [5, 5, 5, 5, 100];
  const ema = computeEma(series);
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  assert.notEqual(ema, mean);
  assert.ok(ema < mean, `expected ema (${ema}) < mean (${mean})`);
  // Newest sample is 5 — EMA should be closer to 5 than to 100.
  assert.ok(Math.abs(ema - 5) < Math.abs(ema - 100));
});

test("empty history returns 0", () => {
  assert.equal(computeEma([]), 0);
});

test("single-sample EMA equals that sample", () => {
  assert.equal(computeEma([0.042]), 0.042);
});
