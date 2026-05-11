/**
 * Pure relationship primitives. Phase 1 of the deterministic-detection plan
 * (`constructions/2026-05-11-prediction-markets-deterministic-detection-part2.md`).
 * Each primitive returns `null` when no violation is present, or
 * `{ violationBps, roles }` when the structural constraint is broken.
 * `violationBps` is rounded to the nearest basis point; `roles` maps a
 * pattern-specific role name to a `marketId`.
 */

export interface ViolationResult {
  violationBps: number;
  roles: Record<string, string>;
}

export interface Priced {
  marketId: string;
  /** YES probability in 0..1. */
  yesPrice: number;
}

interface PairArgs {
  tolBps: number;
}

interface SubsetArgs extends PairArgs {
  wider: Priced;
  narrower: Priced;
}

/**
 * Subset / nested events: the narrower (subset) event cannot price above the
 * wider (superset). Violation when `P(narrower) > P(wider) + tol`.
 */
export function subset(args: SubsetArgs): ViolationResult | null {
  const diffBps = Math.round((args.narrower.yesPrice - args.wider.yesPrice) * 10_000);
  if (diffBps <= args.tolBps) return null;
  return {
    violationBps: diffBps - args.tolBps,
    roles: { wider: args.wider.marketId, narrower: args.narrower.marketId },
  };
}

interface PartitionArgs extends PairArgs {
  members: Priced[];
}

/**
 * Mutually-exclusive AND collectively exhaustive partition: every world maps
 * to exactly one outcome. Sum of YES probabilities must equal 1 ± tol.
 * Violation when `|sum − 1| > tol`.
 */
export function partition_exhaustive(args: PartitionArgs): ViolationResult | null {
  if (args.members.length === 0) return null;
  const sum = args.members.reduce((acc, m) => acc + m.yesPrice, 0);
  const deviationBps = Math.round(Math.abs(sum - 1) * 10_000);
  if (deviationBps <= args.tolBps) return null;
  return {
    violationBps: deviationBps - args.tolBps,
    roles: rolesByIndex(args.members),
  };
}

/**
 * Mutually-exclusive but NOT exhaustive (an "other" / unobserved bucket
 * exists). Sum must stay at-or-below 1 ± tol; under-pricing is allowed.
 * Violation when `sum > 1 + tol`.
 */
export function partition_nonexhaustive(args: PartitionArgs): ViolationResult | null {
  if (args.members.length === 0) return null;
  const sum = args.members.reduce((acc, m) => acc + m.yesPrice, 0);
  const overshootBps = Math.round((sum - 1) * 10_000);
  if (overshootBps <= args.tolBps) return null;
  return {
    violationBps: overshootBps - args.tolBps,
    roles: rolesByIndex(args.members),
  };
}

interface TemporalArgs extends PairArgs {
  earlier: Priced;
  later: Priced;
}

/**
 * Temporal nesting on "by-date" framings: the earlier-resolving window is
 * contained inside the later one, so `P(earlier) ≤ P(later)`. Violation when
 * `P(earlier) > P(later) + tol`.
 */
export function temporal_nested(args: TemporalArgs): ViolationResult | null {
  const diffBps = Math.round((args.earlier.yesPrice - args.later.yesPrice) * 10_000);
  if (diffBps <= args.tolBps) return null;
  return {
    violationBps: diffBps - args.tolBps,
    roles: { earlier: args.earlier.marketId, later: args.later.marketId },
  };
}

interface ComplementArgs extends PairArgs {
  yes: Priced;
  no: Priced;
}

/**
 * Complementary binaries: `P(yes) + P(no) = 1 ± tol`. Violation when the
 * deviation exceeds tolerance — implied arb on either side of the book.
 */
export function complement(args: ComplementArgs): ViolationResult | null {
  const sum = args.yes.yesPrice + args.no.yesPrice;
  const deviationBps = Math.round(Math.abs(sum - 1) * 10_000);
  if (deviationBps <= args.tolBps) return null;
  return {
    violationBps: deviationBps - args.tolBps,
    roles: { yes: args.yes.marketId, no: args.no.marketId },
  };
}

interface ConditionalArgs extends PairArgs {
  /** `P(A AND B)` — joint outcome. */
  aAndB: Priced;
  /** `P(A)` — one of the conjuncts. */
  a: Priced;
}

/**
 * Joint vs marginal: `P(A AND B) ≤ P(A)`. Violation when the joint prices
 * above its marginal, e.g. "Team wins championship" > "Team makes finals".
 */
export function conditional(args: ConditionalArgs): ViolationResult | null {
  const diffBps = Math.round((args.aAndB.yesPrice - args.a.yesPrice) * 10_000);
  if (diffBps <= args.tolBps) return null;
  return {
    violationBps: diffBps - args.tolBps,
    roles: { aAndB: args.aAndB.marketId, a: args.a.marketId },
  };
}

function rolesByIndex(members: Priced[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < members.length; i += 1) {
    out[`m${i}`] = members[i]!.marketId;
  }
  return out;
}
