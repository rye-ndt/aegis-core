/**
 * Unit tests for computePointsV1.
 * Run with: npx tsx --test tests/loyalty.formula.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computePointsV1 } from "../src/helpers/loyalty/pointsFormula";
import type { SeasonConfig } from "../src/helpers/loyalty/pointsFormula";

const BASE_CONFIG: SeasonConfig = {
  globalMultiplier: 1,
  perActionCap: 10_000,
  dailyUserCap: null,
  actionBase: { swap_same_chain: 100, yield_deposit: 200 },
  actionMultiplier: { swap_same_chain: 1, yield_deposit: 2 },
  actionMinUsd: { swap_same_chain: 1 },
  volume: { formula: "sqrt", divisor: 100 },
};

const DEFAULT_BASE = { defaultBase: 50n };

test("flat base when no usdValue (uses volFactor=1 by default)", () => {
  const { points, breakdown } = computePointsV1(
    { actionType: "swap_same_chain" },
    BASE_CONFIG,
    DEFAULT_BASE,
  );
  // base=100, volFactor=1, actionMult=1, globalMult=1, userMult=1
  assert.equal(points, 100n);
  assert.equal(breakdown.volFactor, 1);
});

test("volume factor scales with sqrt of usdValue/divisor", () => {
  // usdValue=100, divisor=100 → ratio=1 → sqrt(1)=1 → raw=100
  const { points } = computePointsV1(
    { actionType: "swap_same_chain", usdValue: 100 },
    BASE_CONFIG,
    DEFAULT_BASE,
  );
  assert.equal(points, 100n);
});

test("volume factor at usdValue=400 → sqrt(4)=2 → raw=200", () => {
  const { points, breakdown } = computePointsV1(
    { actionType: "swap_same_chain", usdValue: 400 },
    BASE_CONFIG,
    DEFAULT_BASE,
  );
  assert.ok(breakdown.volFactor > 1.9 && breakdown.volFactor < 2.1);
  assert.equal(points, 200n);
});

test("below minUsd returns 0 points", () => {
  // actionMinUsd.swap_same_chain = 1, usdValue = 0.5
  const { points } = computePointsV1(
    { actionType: "swap_same_chain", usdValue: 0.5 },
    BASE_CONFIG,
    DEFAULT_BASE,
  );
  assert.equal(points, 0n);
});

test("exactly at minUsd boundary is not filtered", () => {
  const { points } = computePointsV1(
    { actionType: "swap_same_chain", usdValue: 1 },
    BASE_CONFIG,
    DEFAULT_BASE,
  );
  assert.ok(points > 0n);
});

test("perActionCap is respected", () => {
  const config: SeasonConfig = { ...BASE_CONFIG, perActionCap: 50 };
  const { points } = computePointsV1(
    { actionType: "swap_same_chain", usdValue: 10_000 },
    config,
    DEFAULT_BASE,
  );
  assert.equal(points, 50n);
});

test("minimum 1 point when formula rounds to 0", () => {
  const config: SeasonConfig = {
    ...BASE_CONFIG,
    actionBase: { swap_same_chain: 0.0001 },
    perActionCap: 0.0001,
  };
  const { points } = computePointsV1(
    { actionType: "swap_same_chain" },
    config,
    DEFAULT_BASE,
  );
  assert.equal(points, 1n);
});

test("userMultiplier scales points", () => {
  const { points } = computePointsV1(
    { actionType: "swap_same_chain", userMultiplier: 2 },
    BASE_CONFIG,
    DEFAULT_BASE,
  );
  assert.equal(points, 200n);
});

test("globalMultiplier scales points", () => {
  const config: SeasonConfig = { ...BASE_CONFIG, globalMultiplier: 3 };
  const { points } = computePointsV1(
    { actionType: "swap_same_chain" },
    config,
    DEFAULT_BASE,
  );
  assert.equal(points, 300n);
});

test("actionMultiplier for yield_deposit = 2 doubles points", () => {
  // actionBase.yield_deposit=200, actionMult=2 → raw=400
  const { points } = computePointsV1(
    { actionType: "yield_deposit" },
    BASE_CONFIG,
    DEFAULT_BASE,
  );
  assert.equal(points, 400n);
});

test("unknown actionType falls back to defaultBase", () => {
  const { points } = computePointsV1(
    { actionType: "referral" },
    BASE_CONFIG,
    { defaultBase: 75n },
  );
  assert.equal(points, 75n);
});

test("log formula", () => {
  const config: SeasonConfig = {
    ...BASE_CONFIG,
    volume: { formula: "log", divisor: 100 },
  };
  const { breakdown } = computePointsV1(
    { actionType: "swap_same_chain", usdValue: 100 },
    config,
    DEFAULT_BASE,
  );
  // ratio=1, log(1+1)=ln(2)≈0.693
  assert.ok(breakdown.volFactor > 0.6 && breakdown.volFactor < 0.75);
});

test("linear formula", () => {
  const config: SeasonConfig = {
    ...BASE_CONFIG,
    volume: { formula: "linear", divisor: 100 },
  };
  const { breakdown } = computePointsV1(
    { actionType: "swap_same_chain", usdValue: 200 },
    config,
    DEFAULT_BASE,
  );
  // ratio=2
  assert.ok(breakdown.volFactor > 1.9 && breakdown.volFactor < 2.1);
});

test("usdValue=0 with no minUsd produces volFactor=1 (no vol division)", () => {
  // usdValue is defined but 0 → condition `usdValue !== undefined && usdValue > 0` is false
  const config: SeasonConfig = { ...BASE_CONFIG, actionMinUsd: {} };
  const { breakdown } = computePointsV1(
    { actionType: "swap_same_chain", usdValue: 0 },
    config,
    DEFAULT_BASE,
  );
  assert.equal(breakdown.volFactor, 1);
});

test("breakdown fields are consistent with returned points", () => {
  const { points, breakdown } = computePointsV1(
    { actionType: "swap_same_chain", usdValue: 400, userMultiplier: 1.5 },
    BASE_CONFIG,
    DEFAULT_BASE,
  );
  const expected = Math.round(Math.min(breakdown.raw, BASE_CONFIG.perActionCap));
  assert.equal(points, BigInt(Math.max(expected, 1)));
});

test("perActionCap of 0 still returns 1 (floor)", () => {
  const config: SeasonConfig = { ...BASE_CONFIG, perActionCap: 0 };
  const { points } = computePointsV1(
    { actionType: "swap_same_chain" },
    config,
    DEFAULT_BASE,
  );
  assert.equal(points, 1n);
});
