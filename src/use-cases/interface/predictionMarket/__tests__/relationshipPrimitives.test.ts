/**
 * Unit tests for relationshipPrimitives. Phase 1 merge bar: 100% line coverage.
 * Run with: npx tsx --test src/use-cases/interface/predictionMarket/__tests__/relationshipPrimitives.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  complement,
  conditional,
  partition_exhaustive,
  partition_nonexhaustive,
  subset,
  temporal_nested,
  type Priced,
} from "../relationshipPrimitives";

const m = (id: string, yesPrice: number): Priced => ({ marketId: id, yesPrice });

// ---- subset ---------------------------------------------------------------

test("subset: narrower above wider triggers violation", () => {
  // "BTC ≥ 90k" (wider) at 80c, "BTC ≥ 95k" (narrower) at 90c — narrower
  // priced above wider is impossible.
  const r = subset({ wider: m("w", 0.8), narrower: m("n", 0.9), tolBps: 0 });
  assert.deepEqual(r, { violationBps: 1000, roles: { wider: "w", narrower: "n" } });
});

test("subset: equal prices are healthy", () => {
  assert.equal(subset({ wider: m("w", 0.5), narrower: m("n", 0.5), tolBps: 0 }), null);
});

test("subset: narrower below wider is the healthy direction", () => {
  assert.equal(subset({ wider: m("w", 0.6), narrower: m("n", 0.4), tolBps: 0 }), null);
});

test("subset: tolerance absorbs small overshoot", () => {
  // 50 bp gap, 100 bp tolerance → no violation.
  assert.equal(subset({ wider: m("w", 0.5), narrower: m("n", 0.505), tolBps: 100 }), null);
});

test("subset: gap exactly at tolerance does not trigger", () => {
  assert.equal(subset({ wider: m("w", 0.5), narrower: m("n", 0.51), tolBps: 100 }), null);
});

test("subset: tolerance with non-zero violation reports remainder", () => {
  // 200 bp gap, 100 bp tolerance → 100 bp violation.
  const r = subset({ wider: m("w", 0.5), narrower: m("n", 0.52), tolBps: 100 });
  assert.deepEqual(r, { violationBps: 100, roles: { wider: "w", narrower: "n" } });
});

// ---- partition_exhaustive -------------------------------------------------

test("partition_exhaustive: 96/3/0 consensus is healthy", () => {
  const r = partition_exhaustive({
    members: [m("a", 0.96), m("b", 0.03), m("c", 0.0)],
    tolBps: 300,
  });
  assert.equal(r, null);
});

test("partition_exhaustive: 130% overpriced triggers violation", () => {
  const r = partition_exhaustive({
    members: [m("a", 0.6), m("b", 0.4), m("c", 0.3)],
    tolBps: 300,
  });
  assert.ok(r);
  assert.equal(r!.violationBps, 3000 - 300);
  assert.deepEqual(r!.roles, { m0: "a", m1: "b", m2: "c" });
});

test("partition_exhaustive: 70% underpriced triggers violation", () => {
  const r = partition_exhaustive({
    members: [m("a", 0.4), m("b", 0.2), m("c", 0.1)],
    tolBps: 300,
  });
  assert.ok(r);
  assert.equal(r!.violationBps, 3000 - 300);
});

test("partition_exhaustive: empty members returns null", () => {
  assert.equal(partition_exhaustive({ members: [], tolBps: 0 }), null);
});

test("partition_exhaustive: strict tolBps=0 catches sub-bp deviation", () => {
  // 0.333 × 3 = 0.999 → 10 bp deviation, fails strict.
  const r = partition_exhaustive({
    members: [m("a", 0.333), m("b", 0.333), m("c", 0.333)],
    tolBps: 0,
  });
  assert.ok(r);
  assert.equal(r!.violationBps, 10);
});

// ---- partition_nonexhaustive ----------------------------------------------

test("partition_nonexhaustive: under-pricing is allowed (returns null)", () => {
  const r = partition_nonexhaustive({
    members: [m("a", 0.4), m("b", 0.2), m("c", 0.1)],
    tolBps: 0,
  });
  assert.equal(r, null);
});

test("partition_nonexhaustive: overshoot triggers violation", () => {
  const r = partition_nonexhaustive({
    members: [m("a", 0.6), m("b", 0.5), m("c", 0.3)],
    tolBps: 100,
  });
  assert.ok(r);
  assert.equal(r!.violationBps, 4000 - 100);
});

test("partition_nonexhaustive: empty members returns null", () => {
  assert.equal(partition_nonexhaustive({ members: [], tolBps: 0 }), null);
});

// ---- temporal_nested ------------------------------------------------------

test("temporal_nested: by-May-15 17% / by-May-31 28% is healthy", () => {
  assert.equal(
    temporal_nested({ earlier: m("e", 0.17), later: m("l", 0.28), tolBps: 0 }),
    null,
  );
});

test("temporal_nested: flipped direction triggers violation", () => {
  const r = temporal_nested({ earlier: m("e", 0.3), later: m("l", 0.2), tolBps: 0 });
  assert.deepEqual(r, { violationBps: 1000, roles: { earlier: "e", later: "l" } });
});

test("temporal_nested: tolerance absorbs small gap", () => {
  assert.equal(
    temporal_nested({ earlier: m("e", 0.205), later: m("l", 0.2), tolBps: 100 }),
    null,
  );
});

// ---- complement -----------------------------------------------------------

test("complement: 60/40 sums to 1, healthy", () => {
  assert.equal(complement({ yes: m("y", 0.6), no: m("n", 0.4), tolBps: 0 }), null);
});

test("complement: 60/50 (sum 1.10) triggers violation", () => {
  const r = complement({ yes: m("y", 0.6), no: m("n", 0.5), tolBps: 100 });
  assert.deepEqual(r, { violationBps: 1000 - 100, roles: { yes: "y", no: "n" } });
});

test("complement: tolerance absorbs noise", () => {
  assert.equal(complement({ yes: m("y", 0.51), no: m("n", 0.5), tolBps: 200 }), null);
});

// ---- conditional ----------------------------------------------------------

test("conditional: joint priced below marginal is healthy", () => {
  assert.equal(
    conditional({ aAndB: m("ab", 0.3), a: m("a", 0.5), tolBps: 0 }),
    null,
  );
});

test("conditional: joint above marginal triggers violation", () => {
  // "Team wins championship" 40c > "Team makes finals" 30c — making finals
  // is a precondition of winning.
  const r = conditional({ aAndB: m("ab", 0.4), a: m("a", 0.3), tolBps: 0 });
  assert.deepEqual(r, { violationBps: 1000, roles: { aAndB: "ab", a: "a" } });
});

test("conditional: tolerance applies", () => {
  assert.equal(
    conditional({ aAndB: m("ab", 0.305), a: m("a", 0.3), tolBps: 100 }),
    null,
  );
});
