# Prediction Markets — Paper Bets — Part 3 (Resolution Job + P&L)

Date: 2026-05-11
Status: plan
Index: `2026-05-11-prediction-markets-paper-bets.md`
Prerequisite: Part 1 (rows exist), Part 2 (some rows have been inserted).
Unblocks: data-driven decisions on whether to ever turn the on-chain pipeline back on.

## Goal

Resolve open paper bets by polling Polymarket for the underlying market's outcome, compute realized P&L, and update the row in place. After this part, the `aggregatePerformance` endpoint from Part 2 returns non-zero results and we can finally answer **is this model profitable**.

## Files added

- `be/src/use-cases/implementations/predictionMarketPaperResolution.usecase.ts` — resolution orchestrator.
- `be/src/use-cases/interface/predictionMarket/IPolymarketResolutionFetcher.ts` — small port for the resolution lookup (so it's mockable and so we don't bloat `IPolymarketAdapter`).
- `be/src/adapters/implementations/output/predictionMarket/polymarketResolutionFetcher.ts` — adapter impl using Gamma `markets/{id}`.
- `be/src/adapters/implementations/input/jobs/predictionMarketPaperResolutionJob.ts` — periodic job.

## Files changed

- `be/src/workerCli.ts` — register the new job. Mirror the existing `predictionMarketScanJob` registration block.
- `be/src/adapters/inject/assistant.di.ts` — instantiate the resolution fetcher + use-case, wire the job.
- `be/src/helpers/env/predictionMarketEnv.ts` — add `PREDICTION_MARKETS_PAPER_RESOLUTION_INTERVAL_MS` (default `3_600_000` = 1 h), `PREDICTION_MARKETS_PAPER_RESOLUTION_BATCH_SIZE` (default `50` market lookups per tick), `PREDICTION_MARKETS_PAPER_RESOLUTION_LOCK_TTL_MS` (default `300_000`).

## Why a separate port for resolution

`IPolymarketAdapter` today is centered on order books and order signing — adding a "resolution outcome" method bloats it with a concern that has nothing to do with placing orders. A thin separate port:

```ts
export interface IPolymarketResolutionFetcher {
  /** Returns resolution if the market is settled; null if still open or in dispute. */
  fetch(marketId: string): Promise<MarketResolution | null>;
}

export interface MarketResolution {
  marketId: string;
  outcome: 'YES' | 'NO';
  resolvedAt: Date;
  source: 'polymarket-gamma';
}
```

Adapter implementation hits Gamma `GET /markets/{id}` and reads `resolved`, `outcomePrices`, `closedTime`. Treat any market with `resolved=true` and unambiguous outcome prices (e.g. `[1, 0]` or `[0, 1]`) as resolved. Ambiguous prices (`[0.5, 0.5]`) → `null` (still in dispute); flagged at `warn` level so we can investigate.

## Use-case — `PredictionMarketPaperResolutionUseCase`

```ts
const log = createLogger('PaperResolutionUseCase');

export class PredictionMarketPaperResolutionUseCase {
  constructor(
    private readonly paperBetRepo: IPredictionMarketPaperBetRepository,
    private readonly resolutionFetcher: IPolymarketResolutionFetcher,
    private readonly env: PredictionMarketEnv,
  ) {}

  async tick(reqId: string): Promise<{ checked: number; resolved: number }> {
    const start = Date.now();
    log.info({ step: 'tick-start', reqId }, 'paper-resolution tick');

    // 1. Seed: distinct open market ids.
    const marketIds = await this.paperBetRepo.listOpenMarketIds();
    if (marketIds.length === 0) {
      log.info({ step: 'tick-end', reqId, durationMs: Date.now() - start, checked: 0, resolved: 0 }, 'no open bets');
      return { checked: 0, resolved: 0 };
    }

    // 2. Cap per-tick work — large backlogs bleed across ticks.
    const batch = marketIds.slice(0, this.env.paperResolutionBatchSize);

    // 3. Fetch resolutions in parallel (bounded concurrency: 5).
    const resolutions = await pMap(batch, (id) => this.resolutionFetcher.fetch(id), { concurrency: 5 });

    // 4. For each resolved market, load open bets and compute patches.
    const patches: PaperBetResolutionPatch[] = [];
    const resolvedMarketIds = resolutions.filter((r): r is MarketResolution => r !== null).map((r) => r.marketId);
    if (resolvedMarketIds.length === 0) {
      log.info({ step: 'tick-end', reqId, durationMs: Date.now() - start, checked: batch.length, resolved: 0 }, 'no resolutions this tick');
      return { checked: batch.length, resolved: 0 };
    }
    const openBets = await this.paperBetRepo.listOpenByMarkets(resolvedMarketIds);
    const resolutionByMarket = new Map(resolutions.filter(Boolean).map((r) => [r!.marketId, r!]));

    for (const bet of openBets) {
      const res = resolutionByMarket.get(bet.marketId);
      if (!res) continue;
      const won = bet.side === res.outcome;
      const payoutUsdcCents = won
        ? Number((bet.sharesE6 * 10_000n) / 1_000_000n)  // shares × $1 = shares × 10 000 cents
        : 0;
      const realizedPnlUsdcCents = payoutUsdcCents - bet.stakeUsdcCents;
      patches.push({
        id: bet.id,
        outcome: res.outcome,
        payoutUsdcCents,
        realizedPnlUsdcCents,
      });
    }

    // 5. Atomic batch resolve.
    const resolved = await this.paperBetRepo.resolveMany(patches);
    log.info(
      { step: 'tick-end', reqId, durationMs: Date.now() - start, checked: batch.length, resolved },
      'paper-resolution tick complete',
    );
    return { checked: batch.length, resolved };
  }
}
```

Notes:
- The job ticks hourly by default, so even a 200-bet backlog clears in 4 ticks at `batchSize=50`. Tune via env if needed.
- `pMap` concurrency=5 keeps us well under any reasonable Polymarket rate limit while not serializing.
- Ambiguous / unresolved markets are silently skipped (`null` return). A separate `warn` already fires inside the fetcher when prices are degenerate.

## Job — `predictionMarketPaperResolutionJob.ts`

Mirror `predictionMarketScanJob.ts`. Key elements:

- Redis lock keyed `pm:paper-resolution:lock`, TTL = `paperResolutionLockTtlMs`. Skip tick if already held.
- Interval = `paperResolutionIntervalMs`.
- `reqId` generated per tick (uuid v4) for log correlation.
- On uncaught exception: `log.error({ err, reqId }, 'paper-resolution tick failed')`; do not crash the worker, do not throw — next tick will retry.

## Worker registration — `workerCli.ts`

Add to the existing job registration block:

```ts
if (env.predictionMarkets.enabled) {
  registerJob({
    name: 'predictionMarketPaperResolution',
    intervalMs: env.predictionMarkets.paperResolutionIntervalMs,
    handler: (reqId) => paperResolutionUseCase.tick(reqId),
  });
}
```

Gate on the same `PREDICTION_MARKETS_ENABLED` flag the other PM jobs use — if PM is off, no resolution job runs.

## Aggregation refinements — backend

After this part lands, `aggregatePerformance` will start returning meaningful numbers. Two small upgrades worth doing in the same PR:

1. **Add `?since=<iso>` query param** to `GET /predictionMarket/paperPerformance` and the admin variant. Defaults to 30 days ago. Filters `entry_at >= since` so a recent regression doesn't get hidden by stale wins.
2. **Add `medianStakeUsdcCents`** and **`medianPnlUsdcCents`** to `PerformanceBucket`. These are computed in JS post-query — we already pull per-bet rows? Actually we don't, the aggregate is SQL-side. For medians, use Postgres `percentile_cont(0.5) within group (order by ...)`. Cheap, exact.

Document the new fields in `be/STATUS.md` and bump the example response in the route docstring.

## Edge cases

- **A finding's market is voided by Polymarket** — Gamma exposes a `disputed` or `umaResolutionStatuses` field. If we detect a void state, set `status='voided'`, leave `payoutUsdcCents` / `realizedPnlUsdcCents` as `null`. `aggregatePerformance` already filters to `status='resolved'`, so voided bets stay out of ROI.
- **The bet was placed at a price that the market never sustained** — irrelevant. We locked entry price at confirmation; P&L is computed against the **outcome**, not against any subsequent price. This is correct paper-trading semantics.
- **The user places multiple paper bets on the same finding** — allowed. Each gets its own row, each gets resolved independently. Aggregate stats reflect each separately.
- **Resolution happens between two ticks where a user just placed a bet** — fine. The next tick picks it up. Worst-case latency = `paperResolutionIntervalMs`.

## Tests

`be/src/__tests__/predictionMarketPaperResolution.test.ts`:

- 4-bet fixture (1 win deterministic, 1 loss deterministic, 1 win LLM, 1 loss LLM) — verify `resolveMany` patches are correct and `realizedPnlUsdcCents` math is exact (no float drift).
- Resolution fetcher returns `null` for half the markets → corresponding bets stay `open`.
- Voided market (Gamma returns `[0.5, 0.5]` ambiguous) → fetcher returns `null`, bet stays `open` (the void-flagging is a follow-up; punt to status doc).
- BigInt path: `sharesE6 = 1_234_567` → payout math doesn't overflow JS `number` (only the final cents value is `Number()`-cast, which is well within safe-integer range for any reasonable stake).
- Concurrency test: two parallel `tick()` calls — second one finds the lock held and exits cleanly.

## Logging fields introduced

- `resolved` (count per tick)
- `checked` (count per tick)
- `marketId` (already common; reaffirming)

## Acceptance

- After Part 2 plus a few minutes of waiting for a real Polymarket market to resolve (or a manual `UPDATE prediction_market_paper_bets SET market_id='<known-resolved>'` test row): the row's `status` flips to `'resolved'` within one tick, `outcome` matches Polymarket's, `payoutUsdcCents` math is exact.
- `GET /admin/prediction-markets/paper-performance?groupBy=detectorSource` returns two buckets (`deterministic`, `llm`) with `roiBps` populated.
- Worker logs show `paper-resolution tick complete` hourly with sensible `checked`/`resolved` counts.
- The replay regression test and the existing PM scan/extract jobs are unaffected.
