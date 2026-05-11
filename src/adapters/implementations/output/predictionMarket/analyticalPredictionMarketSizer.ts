/**
 * Closed-form sizer for the three structural patterns (subset / temporal-nested /
 * partition). The optimal trade is analytical for each, so a generic LP is
 * overkill. Worst-case payoff across resolution branches is enforced ≥ 0 —
 * pure arb only.
 */
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  IPredictionMarketSizer,
  MarketOrderBook,
  PricedLevel,
  SizedTrade,
  SizerInput,
  SizerOutcome,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketSizer";

const log = createLogger("predictionMarketSizer");

/** Helper — total cost (USDC) of consuming `shares` against an ask ladder. */
function costToFill(asks: PricedLevel[], shares: number): { cost: number; avgPrice: number } | null {
  if (shares <= 0) return { cost: 0, avgPrice: 0 };
  let remaining = shares;
  let cost = 0;
  for (const lvl of asks) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.shares);
    cost += take * lvl.priceFraction;
    remaining -= take;
  }
  if (remaining > 0.0001) return null; // depth insufficient
  return { cost, avgPrice: cost / shares };
}

/** Total depth across an ask ladder. */
function totalDepth(asks: PricedLevel[]): number {
  return asks.reduce((acc, lvl) => acc + lvl.shares, 0);
}

/**
 * Walk N ask ladders together for the partition case. Tranche = min depth
 * remaining across all N books at the current level. Stops when (a) next
 * unit cost exceeds `(N-1)` (arb gone), (b) any book runs out of depth, or
 * (c) budget would be exceeded. Returns the maximum shares and per-book cost.
 */
function walkPartitionBooks(
  bookAsks: PricedLevel[][],
  budget: number,
  arbCeiling: number,
): { shares: number; cost: number; perBookCost: number[] } {
  const N = bookAsks.length;
  const ptrIdx = new Array<number>(N).fill(0);
  const ptrRemain = bookAsks.map((asks) => asks[0]?.shares ?? 0);
  const perBookCost = new Array<number>(N).fill(0);
  let shares = 0;
  while (true) {
    // Resolve current top-of-remaining price per book; advance pointers that
    // emptied out. Bail out if any book is exhausted.
    let unitCost = 0;
    let trancheShares = Number.POSITIVE_INFINITY;
    let bookExhausted = false;
    const currentPrices = new Array<number>(N);
    for (let i = 0; i < N; i += 1) {
      const asks = bookAsks[i]!;
      let idx = ptrIdx[i]!;
      let remain = ptrRemain[i]!;
      while (idx < asks.length && remain <= 0) {
        idx += 1;
        remain = asks[idx]?.shares ?? 0;
      }
      if (idx >= asks.length) {
        bookExhausted = true;
        break;
      }
      ptrIdx[i] = idx;
      ptrRemain[i] = remain;
      currentPrices[i] = asks[idx]!.priceFraction;
      unitCost += asks[idx]!.priceFraction;
      if (remain < trancheShares) trancheShares = remain;
    }
    if (bookExhausted) break;
    if (unitCost >= arbCeiling) break;
    const remainingBudget = budget - perBookCost.reduce((a, b) => a + b, 0);
    const trancheCost = trancheShares * unitCost;
    if (trancheCost > remainingBudget) {
      const partial = remainingBudget / unitCost;
      if (partial <= 0) break;
      shares += partial;
      for (let i = 0; i < N; i += 1) {
        perBookCost[i] += partial * currentPrices[i]!;
      }
      break;
    }
    shares += trancheShares;
    for (let i = 0; i < N; i += 1) {
      perBookCost[i] += trancheShares * currentPrices[i]!;
      ptrRemain[i] = ptrRemain[i]! - trancheShares;
    }
  }
  const cost = perBookCost.reduce((a, b) => a + b, 0);
  return { shares, cost, perBookCost };
}

/**
 * Walk two ask ladders tranche-by-tranche, allocating equal shares to both
 * sides. Stops when (a) the next unit cost would push gross spend past
 * `budget`, (b) either side runs out of depth, or (c) combined unit cost ≥ 1
 * (arb dries up). Returns the maximum number of shares we can actually buy,
 * along with the gross cost per side. Fixes the budget overshoot the prior
 * top-of-book heuristic allowed on multi-level books.
 */
function walkArbBooks(
  widerAsks: PricedLevel[],
  narrowerAsks: PricedLevel[],
  budget: number,
): { shares: number; cost: number; widerCost: number; narrowerCost: number } {
  let shares = 0;
  let widerCost = 0;
  let narrowerCost = 0;
  let wi = 0;
  let ni = 0;
  let wRemain = widerAsks[0]?.shares ?? 0;
  let nRemain = narrowerAsks[0]?.shares ?? 0;
  while (wi < widerAsks.length && ni < narrowerAsks.length) {
    const wPrice = widerAsks[wi]!.priceFraction;
    const nPrice = narrowerAsks[ni]!.priceFraction;
    const unitCost = wPrice + nPrice;
    if (unitCost >= 1) break;
    const tranche = Math.min(wRemain, nRemain);
    if (tranche <= 0) break;
    const trancheCost = tranche * unitCost;
    const remainingBudget = budget - (widerCost + narrowerCost);
    if (trancheCost > remainingBudget) {
      const partial = remainingBudget / unitCost;
      if (partial <= 0) break;
      shares += partial;
      widerCost += partial * wPrice;
      narrowerCost += partial * nPrice;
      break;
    }
    shares += tranche;
    widerCost += tranche * wPrice;
    narrowerCost += tranche * nPrice;
    wRemain -= tranche;
    nRemain -= tranche;
    if (wRemain <= 0) {
      wi += 1;
      wRemain = widerAsks[wi]?.shares ?? 0;
    }
    if (nRemain <= 0) {
      ni += 1;
      nRemain = narrowerAsks[ni]?.shares ?? 0;
    }
  }
  return { shares, cost: widerCost + narrowerCost, widerCost, narrowerCost };
}

export class AnalyticalPredictionMarketSizer implements IPredictionMarketSizer {
  async size(input: SizerInput): Promise<SizerOutcome> {
    const start = Date.now();
    const { finding, reqId } = input;
    log.info({ step: "size-start", reqId, findingId: finding.findingId, pattern: finding.patternType }, "size");

    // Routing key: presence of role tags (subset / temporal) vs none
    // (partition). The detector populates exactly one of these tag pairs.
    const isSubset = finding.widerMarketId && finding.narrowerMarketId;
    const isTemporal = finding.earlierMarketId && finding.laterMarketId;
    const isPartition = !isSubset && !isTemporal && finding.patternType === "logical_inconsistency";
    let outcome: SizerOutcome;
    if (isSubset) {
      outcome = this.sizeSubset(input, finding.widerMarketId!, finding.narrowerMarketId!);
    } else if (isTemporal) {
      outcome = this.sizeTemporal(input, finding.earlierMarketId!, finding.laterMarketId!);
    } else if (isPartition && finding.marketsInvolved.length >= 2) {
      outcome = this.sizePartition(input);
    } else {
      outcome = { kind: "uneconomic", bestProfitUsdc: 0, reason: "unsupported-pattern" };
    }

    log.info(
      {
        step: "size-end",
        reqId,
        findingId: finding.findingId,
        kind: outcome.kind,
        expectedProfitUsdc: outcome.kind === "sized" ? outcome.expectedProfitUsdc : undefined,
        durationMs: Date.now() - start,
      },
      "size",
    );
    return outcome;
  }

  /**
   * Subset: BUY YES on wider + BUY NO on narrower. Worst-case (W=Y, N=Y)
   * payoff per share = 1 − (avg_p_w + avg_no_p_n). The arb exists only when
   * the sum stays below 1; deeper book levels eat into the gap, so we walk
   * both sides tranche-by-tranche and stop the moment unit cost ≥ 1 or one
   * of: depth on either side, or remaining budget would be exceeded.
   */
  private sizeSubset(input: SizerInput, widerId: string, narrowerId: string): SizerOutcome {
    const wider = input.orderBook[widerId];
    const narrower = input.orderBook[narrowerId];
    if (!wider || !narrower) {
      return { kind: "uneconomic", bestProfitUsdc: 0, reason: "missing-order-book" };
    }
    const widerAsks = wider.yesAsks;
    const narrowerAsks = narrower.noAsks;
    if (widerAsks.length === 0 || narrowerAsks.length === 0) {
      return { kind: "uneconomic", bestProfitUsdc: 0, reason: "empty-ask-side" };
    }
    if (widerAsks[0]!.priceFraction + narrowerAsks[0]!.priceFraction >= 1) {
      return { kind: "uneconomic", bestProfitUsdc: 0, reason: "top-of-book-not-arb" };
    }
    const walk = walkArbBooks(widerAsks, narrowerAsks, input.budgetUsdc);
    if (walk.shares <= 0) {
      return { kind: "uneconomic", bestProfitUsdc: 0, reason: "no-share-capacity" };
    }
    const fees = walk.cost * (input.feeBps / 10_000);
    const grossPayoff = walk.shares * 1.0; // worst-case branch (W=Y, N=Y inadmissible; W=Y,N=N or W=N,N=N both pay 1)
    const minPayoffGross = grossPayoff - walk.cost;
    const minPayoffNet = minPayoffGross - fees - input.gasEstimateUsdc;
    if (minPayoffNet <= 0) {
      return { kind: "uneconomic", bestProfitUsdc: minPayoffNet, reason: "negative-after-fees" };
    }
    const widerAvg = walk.shares > 0 ? walk.widerCost / walk.shares : 0;
    const narrowerAvg = walk.shares > 0 ? walk.narrowerCost / walk.shares : 0;
    const trades: SizedTrade[] = [
      { marketId: widerId, outcome: "YES", shares: walk.shares, avgPriceFraction: widerAvg },
      { marketId: narrowerId, outcome: "NO", shares: walk.shares, avgPriceFraction: narrowerAvg },
    ];
    return {
      kind: "sized",
      trades,
      expectedProfitUsdc: minPayoffNet,
      // Same as expectedProfitUsdc for pure arb (every branch pays the same);
      // surfaced separately so the broadcast card can show pre-cost worst case.
      minPayoffUsdc: minPayoffGross,
    };
  }

  /**
   * Temporal nesting is structurally the same trade as subset, with `later`
   * playing the role of wider and `earlier` playing narrower.
   */
  private sizeTemporal(input: SizerInput, earlierId: string, laterId: string): SizerOutcome {
    return this.sizeSubset(input, laterId, earlierId);
  }

  /**
   * Partition with Σ p_i > 1: BUY NO on every member at equal share count.
   * Cost per unit = Σ (1 − p_i) = Σ NO_top. Payoff in any "one of N" branch
   * is (N − 1) shares × $1. Net profit per unit = (N − 1) − Σ NO_avg.
   *
   * Tranche-walks the N NO-ask ladders together so the budget cap is exact
   * even when deeper levels are more expensive than the top.
   */
  private sizePartition(input: SizerInput): SizerOutcome {
    const ids = input.finding.marketsInvolved;
    const books: MarketOrderBook[] = [];
    for (const id of ids) {
      const book = input.orderBook[id];
      if (!book) return { kind: "uneconomic", bestProfitUsdc: 0, reason: "missing-order-book" };
      books.push(book);
    }
    const tops = books.map((b) => b.noAsks[0]?.priceFraction);
    if (tops.some((p) => p === undefined)) {
      return { kind: "uneconomic", bestProfitUsdc: 0, reason: "empty-ask-side" };
    }
    const N = ids.length;
    const sumTopNo = tops.reduce<number>((acc, p) => acc + (p as number), 0);
    if (sumTopNo >= N - 1) {
      return { kind: "uneconomic", bestProfitUsdc: 0, reason: "partition-not-arb" };
    }
    const walk = walkPartitionBooks(books.map((b) => b.noAsks), input.budgetUsdc, N - 1);
    if (walk.shares <= 0) {
      return { kind: "uneconomic", bestProfitUsdc: 0, reason: "no-share-capacity" };
    }
    const fees = walk.cost * (input.feeBps / 10_000);
    const grossPayoff = (N - 1) * walk.shares;
    const minPayoffGross = grossPayoff - walk.cost;
    const minPayoffNet = minPayoffGross - fees - input.gasEstimateUsdc;
    if (minPayoffNet <= 0) {
      return { kind: "uneconomic", bestProfitUsdc: minPayoffNet, reason: "negative-after-fees" };
    }
    const trades: SizedTrade[] = ids.map((id, i) => ({
      marketId: id,
      outcome: "NO" as const,
      shares: walk.shares,
      avgPriceFraction: walk.shares > 0 ? walk.perBookCost[i]! / walk.shares : 0,
    }));
    return {
      kind: "sized",
      trades,
      expectedProfitUsdc: minPayoffNet,
      minPayoffUsdc: minPayoffGross,
    };
  }
}
