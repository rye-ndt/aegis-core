# Prediction Markets — Deterministic Detection — Part 6 (Phase 5: LP sizing)

Date: 2026-05-11
Status: plan
Index: `2026-05-11-prediction-markets-deterministic-detection.md`
Prerequisite: Part 5 merged + at least one cut-over subject is producing deterministic `VerifiedFinding`s with role tags + `polymarketAdapter` extended with order-book depth (one-line addition described below).
Unblocks: Part 7 (cutover checklist requires sized findings to certify per-category profitability before promotion).

## Goal

Each verified violation is augmented with concrete share quantities and net expected profit. Findings whose optimal profit < execution cost are dropped before broadcast. 3–4 days.

## New port

`be/src/use-cases/interface/predictionMarket/IPredictionMarketSizer.ts`:

```ts
export interface PricedLevel {
  priceFraction: number;     // 0..1
  shares: number;            // depth at this level
}

export interface SizerInput {
  finding: VerifiedFinding;
  orderBook: Record<
    string,
    { yesBids: PricedLevel[]; yesAsks: PricedLevel[]; noBids: PricedLevel[]; noAsks: PricedLevel[] }
  >;
  budgetUsdc: number;
  feeBps: number;
  gasEstimateUsdc: number;
  reqId: string;
}

export type SizerOutcome =
  | {
      kind: "sized";
      trades: Array<{ marketId: string; outcome: "YES" | "NO"; shares: number; avgPriceFraction: number }>;
      expectedProfitUsdc: number;
      minPayoffUsdc: number;
    }
  | { kind: "uneconomic"; bestProfitUsdc: number; reason: string };

export interface IPredictionMarketSizer {
  size(input: SizerInput): Promise<SizerOutcome>;
}
```

## Adapter

`be/src/adapters/implementations/output/predictionMarket/glpkPredictionMarketSizer.ts`:

- `glpk.js` (WASM-bound GLPK), initialised once in the constructor.
- Per-finding LP:
  - **Variables:** `xij` = shares to buy of outcome `j` in market `i` at price level `k` — one var per (market, outcome, level).
  - **Objective:** maximise `expected_profit = Σ payoff_in_branch × P(branch) − Σ xij × price_ij × (1 + fee) − gasEstimateUsdc`.
  - For `subset` violations the resolution branches are the four (wider-Y/N) × (narrower-Y/N) combinations; constraints rule out the impossible one (narrower-Y AND wider-N).
  - For `partition_exhaustive` violations the branches are the N exhaustive outcomes.
- **Constraints:**
  - `xij ≤ depth at level k` (order-book depth).
  - `Σ xij × price_ij ≤ budgetUsdc`.
  - `xij ≥ 0`.
  - `payoff_in_branch ≥ 0` for every branch (no losing scenarios — pure arbitrage). For `confidence: 'high'` findings where this is infeasible, fall back to a "minimax negative payoff" relaxation; otherwise return `uneconomic`.
- Output maps directly to `Trade[]` and `expectedProfitUsdc`. The minimum payoff across branches is used for the "is this profitable?" filter and for the broadcast card.

Fallback: if `glpk.js` WASM bootstrap fails (CI / sandbox edge case), fall back to `javascript-lp-solver` (pure JS, slower, less capable). Adapter constructor logs which solver booted.

## Order-book depth

`polymarketAdapter.ts` already has `getOrderbookTopOfBook(outcomeTokenId)`. Extend with:

```ts
getOrderbookDepth(args: {
  outcomeTokenId: string;
  side: "BUY" | "SELL";
  depthLevels: number;       // default 10
}): Promise<PricedLevel[]>;
```

One CLOB call per (market × outcome) involved in the finding. Cache results in-memory for `verifyFreshnessMs` (re-using the verifier's freshness window) so the same finding's order book is fetched once per tick.

## Verifier integration

`PredictionMarketVerifier.verify` gains an optional sizing step:

```ts
if (this.cfg.sizingEnabled) {
  const sized = await this.sizer.size({
    finding: v, orderBook, budgetUsdc, feeBps, gasEstimateUsdc, reqId,
  });
  if (sized.kind === 'uneconomic') { drop('uneconomic'); continue; }
  v = {
    ...v,
    sizedTrades: sized.trades,
    expectedProfitUsdc: sized.expectedProfitUsdc,
    minPayoffUsdc: sized.minPayoffUsdc,
  };
}
```

`VerifiedFinding` gains optional fields:

```ts
sizedTrades?: Array<{ marketId: string; outcome: "YES" | "NO"; shares: number; avgPriceFraction: number }>;
expectedProfitUsdc?: number;
minPayoffUsdc?: number;
```

`prediction_market_findings` gains three nullable columns:

```ts
sizedTrades: jsonb("sized_trades"),
expectedProfitUsdcCents: integer("expected_profit_usdc_cents"),
minPayoffUsdcCents: integer("min_payoff_usdc_cents"),
```

(Stored as integer cents to match the existing bet-pipeline convention.)

## Broadcast surface

`predictionMarketFindingBroadcaster.ts` adds two `details` rows when `expectedProfitUsdc` is set:

```
Profit estimate: $X.XX (worst case: $Y.YY)
Trades: BUY 1.4 YES on "BTC ≥ 95k" @ $0.08; BUY 1.6 NO on "BTC ≥ 100k" @ $0.91
```

These are appended to the existing `details` array. **No `IntentVerb` change. No `ResultAction.kind` change.** The bet handler in the FE is unaffected.

## Env additions

```ts
sizingEnabled: bool("PREDICTION_MARKETS_SIZING_ENABLED", false),
sizerFeeBps: num("PREDICTION_MARKETS_SIZER_FEE_BPS", 200),
sizerGasEstimateUsdc: num("PREDICTION_MARKETS_SIZER_GAS_ESTIMATE_USDC", 0.05),
sizerDepthLevels: num("PREDICTION_MARKETS_SIZER_DEPTH_LEVELS", 10),
```

`PREDICTION_MARKETS_SIZING_ENABLED=false` (default) keeps verification behaviour identical to today. Operators flip after a manual sane-run.

## Logging

- New scope: `predictionMarketSizer`.
- New step events: `size-start`, `size-end`.
- Per-finding log: `log.info({ step: 'size-end', reqId, findingId, kind, expectedProfitUsdc, durationMs }, 'size')`.

## Unit tests

`__tests__/glpkPredictionMarketSizer.test.ts`:

- 2-market `subset` arb with deep books — clear profit, sized to budget.
- 2-market arb where depth is too thin — sized down to depth, still profitable.
- 2-market arb that is uneconomic after fees + gas — `uneconomic` outcome.
- WASM bootstrap test — solver constructor returns successfully.

## Side-effect / regression checklist

- **`VerifiedFinding` shape additive**: new fields are optional; existing readers (broadcaster, repo, bet pipeline) ignore them.
- **`prediction_market_findings` schema**: three new nullable columns. Verify post-migrate per the journal-`when` caveat.
- **CLOB call rate**: depth fetches add ~`2 × markets_per_finding` extra CLOB calls per tick. With ~5 findings × 2 markets = 20 calls per tick over a 30-min interval, well under any plausible CLOB rate limit.
- **`glpk.js` bundling**: WASM asset must be bundled into the worker image. CI verifies bootstrap.
- **Bet pipeline**: untouched. The bet handler does not read `sizedTrades` (the user can still tap a side button regardless of sizing output). Future improvement could pre-fill `stakeUsdc` from `sizedTrades`, but that is out of scope.

## Done

- [ ] `glpkPredictionMarketSizer` lands. WASM bootstrap exercised in CI.
- [ ] Verifier integrates the sizer when `PREDICTION_MARKETS_SIZING_ENABLED=true`.
- [ ] Findings whose `expectedProfitUsdc < 0` are dropped before broadcast with `reason: 'uneconomic'` in the log.
- [ ] Broadcast card shows the sized trades and expected profit when available.
- [ ] LP unit tests pass; coverage on the sizer adapter ≥90%.
- [ ] `STATUS.md` documents the sizer port and the new finding fields.

## Hand-off to Part 7

Part 7 promotes subjects to deterministic-only after they pass the shadow agreement bar. The sizer's `expectedProfitUsdc` becomes one of Part 7's promotion criteria: a subject is only promoted if its sized findings show positive expected profit on a meaningful share of broadcasts.
