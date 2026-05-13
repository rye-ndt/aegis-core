# Prediction Markets — Paper Bets — Part 2 (Placement Use-Case + HTTP Routes)

Date: 2026-05-11
Status: plan
Index: `2026-05-11-prediction-markets-paper-bets.md`
Prerequisite: Part 1 (schema + repo + port).
Unblocks: Part 3 (resolution job, which reads rows this part writes), Part 4 (frontend, which calls the HTTP routes added here).

## Goal

Wire the click → record path end-to-end on the backend. After this part, a test client can `POST /predictionMarket/paperBet` with a `findingId` + `side` + `stakeUsdcCents`, the backend fetches live CLOB top-of-book, snapshots entry price, and persists a row.

## Files added

- `be/src/use-cases/implementations/predictionMarketPaperBet.usecase.ts` — orchestrator.

## Files changed

- `be/src/adapters/implementations/output/predictionMarket/polymarketAdapter.ts` — confirm `getOrderBookTop(marketId, side)` exists; if it returns both sides today, add a thin `getTopForSide(marketId, side): Promise<{ priceBps: number; depthShares: number }>` wrapper. (Read the file first; reuse the existing shape if possible.)
- `be/src/telegramCli.ts` — add three routes (`POST /predictionMarket/paperBet`, `GET /predictionMarket/paperBets`, `GET /predictionMarket/paperPerformance`) and one admin route (`GET /admin/prediction-markets/paper-performance`). Match the auth + error-handling style of the existing `/predictionMarket/*` block.
- `be/src/adapters/inject/assistant.di.ts` — instantiate `PredictionMarketPaperBetRepository`, `PredictionMarketPaperBetUseCase`; pass into the HTTP layer.
- `be/src/helpers/env/predictionMarketEnv.ts` — add `PREDICTION_MARKETS_PAPER_STAKE_MIN_USDC_CENTS` (default `100` = $1), `PREDICTION_MARKETS_PAPER_STAKE_MAX_USDC_CENTS` (default `100_000` = $1 000), `PREDICTION_MARKETS_PAPER_PRICE_TTL_MS` (default `15_000`).

## Use-case — `PredictionMarketPaperBetUseCase`

```ts
const log = createLogger('PaperBetUseCase');

export class PredictionMarketPaperBetUseCase {
  constructor(
    private readonly paperBetRepo: IPredictionMarketPaperBetRepository,
    private readonly findingRepo: IPredictionMarketRepository,   // existing
    private readonly polymarket: IPolymarketAdapter,             // existing
    private readonly env: PredictionMarketEnv,
  ) {}

  async place(args: {
    reqId: string;
    userId: string;
    findingId: string;
    side: PaperBetSide;
    stakeUsdcCents: number;
  }): Promise<PaperBet> {
    const { reqId, userId, findingId, side, stakeUsdcCents } = args;
    log.info({ step: 'started', reqId, userId, findingId, side, stakeUsdcCents }, 'paper-bet place');

    // 1. Validate stake bounds.
    if (stakeUsdcCents < this.env.paperStakeMinUsdcCents) throw new ValidationError('stake-below-min');
    if (stakeUsdcCents > this.env.paperStakeMaxUsdcCents) throw new ValidationError('stake-above-max');

    // 2. Load finding + its cluster.
    const finding = await this.findingRepo.findFindingById(findingId);
    if (!finding) throw new NotFoundError('finding');
    const cluster = await this.findingRepo.findClusterById(finding.clusterId);
    if (!cluster) throw new NotFoundError('cluster');

    // 3. Resolve which market the side maps to.
    //    Findings name role-tagged market ids (widerMarketId / narrowerMarketId / etc.).
    //    Side 'A' → first market in the finding's marketsInvolved, 'B' → second.
    //    NOTE: the broadcast callback uses `place_bet:findingId:A|B`. The HTTP route translates
    //    'A'/'B' to YES/NO before calling .place(); the use-case sees only YES/NO.
    const marketId = pickMarketForSide(finding, side);
    if (!marketId) throw new ValidationError('side-has-no-market');

    // 4. Fetch live CLOB top-of-book for this market+side.
    const top = await this.polymarket.getTopForSide(marketId, side);
    if (!top || top.priceBps <= 0 || top.priceBps >= 10_000) {
      log.warn({ reqId, marketId, side, top }, 'paper-bet rejected: degenerate price');
      throw new ValidationError('price-unavailable');
    }
    log.debug({ reqId, marketId, side, priceBps: top.priceBps, depthShares: top.depthShares }, 'paper-bet price snapshot');

    // 5. Derive shares (fixed-point, BigInt).
    //    sharesE6 = (stakeCents * 1_000_000 * 10_000) / (priceBps * 100)
    //             = (stakeCents * 1_000_000) / (priceBps / 100)
    //    Compute in integer math: sharesE6 = BigInt(stakeCents) * 100n * 1_000_000n / BigInt(priceBps)
    //    (Same as: shares = stakeUsdc / (priceBps / 10_000), then × 1e6.)
    const sharesE6 = (BigInt(stakeUsdcCents) * 100n * 1_000_000n) / BigInt(top.priceBps);

    // 6. Insert.
    const row = await this.paperBetRepo.insert({
      userId,
      findingId,
      clusterId: cluster.id,
      marketId,
      subject: cluster.derivedSubject ?? null,
      side,
      stakeUsdcCents,
      entryPriceBps: top.priceBps,
      sharesE6,
      detectorSource: cluster.derivedSubject ? 'deterministic' : 'llm',
    });

    log.info({ step: 'succeeded', reqId, userId, findingId, paperBetId: row.id, entryPriceBps: top.priceBps }, 'paper-bet placed');
    return row;
  }
}
```

Side-effect surface: one repo write, one Polymarket read. No outbound user notifications (the FE returns the receipt and closes the mini-app).

### `pickMarketForSide` — pattern-aware mapping

Defined inline in the use-case file (it's small). The mapping is:

| Finding pattern | `side='A'` | `side='B'` |
|---|---|---|
| `logical_inconsistency` / `implied_contradiction` (nested) | `widerMarketId` (YES) | `narrowerMarketId` (YES) |
| `term_structure_anomaly` | `earlierMarketId` (YES) | `laterMarketId` (YES) |
| `movement_divergence` | first market in `marketsInvolved` (YES) | second market (YES) |
| `*` mutually-exclusive | first member (YES) | second member (YES) |

For all cases above, the **bet is on YES of the named market** — the role tags already encode the direction the model thinks is mispriced. We do not let the user invert to NO; if they want the opposite leg, that's a separate finding. This keeps the dataset clean: `side` in the table corresponds to "did the model's call work" not "what direction did the user bet".

(Reconsider this if Part 3's resolved-bet stats show the role-tag direction is wrong often enough that we want to compare YES vs NO. For now: lock direction, optimize for evaluation clarity.)

## HTTP routes — `telegramCli.ts`

All routes are authenticated via the existing Privy bearer-token middleware (`userId` resolved server-side). No `:userId` in the URL. Mirror the response/error shape of the existing `/predictionMarket/intent/*` routes.

### `POST /predictionMarket/paperBet`

Body:
```ts
{ findingId: string; side: 'A' | 'B' | 'YES' | 'NO'; stakeUsdcCents: number }
```

The route translates `'A'/'B'` → `'YES'/'NO'` via the same `pickMarketForSide` mapping before delegating to the use-case. Accepting `'YES'/'NO'` directly is for direct API callers; the FE will always send `'A'/'B'` because that's what the broadcast callback carries.

Response:
```ts
{ paperBet: PaperBet }
```

Errors:
- `400 validation` — stake out of bounds, side has no market.
- `404 not_found` — finding or cluster missing.
- `503 price_unavailable` — Polymarket returned degenerate price (0 or 10 000 bps).
- `500` — anything else (use-case catches + logs `error({ err, userId, findingId })`).

### `GET /predictionMarket/paperBets`

Query: `?status=open|resolved|voided` (optional), `?limit=` (default 50, max 200).
Response: `{ paperBets: PaperBet[] }`.

### `GET /predictionMarket/paperPerformance`

Query: `?groupBy=overall|subject|clusterId|detectorSource` (default `overall`).
Response: `{ buckets: PerformanceBucket[] }`.

User-scoped (the auth middleware sets `userId`).

### `GET /admin/prediction-markets/paper-performance`

Same query shape as the user route, but **global** (no `userId` filter). Auth: same admin gate the existing `/admin/prediction-markets/shadow-agreement` route uses (`PREDICTION_MARKETS_ADMIN_CHAT_ID` or equivalent). Returns the same `PerformanceBucket[]` shape. This is the "is the model profitable" endpoint we built this whole feature for.

### Logging at the route layer

Per CLAUDE.md adapters convention:

```ts
log.info({ reqId, method: 'POST', path: '/predictionMarket/paperBet', userId }, 'request received');
// ... use-case call ...
log.info({ reqId, paperBetId, durationMs }, 'paper-bet request done');
// in catch:
log.error({ err, reqId, userId, findingId }, 'paper-bet request failed');
```

`reqId` comes from the existing request-id middleware. Don't log the body verbatim — it's small enough to spread the fields explicitly.

## DI wiring — `assistant.di.ts`

Add after the existing prediction-market block (~line 100):

```ts
const paperBetRepo = new PredictionMarketPaperBetRepository(db);
const paperBetUseCase = new PredictionMarketPaperBetUseCase(
  paperBetRepo,
  predictionMarketRepo,
  polymarketAdapter,
  env,
);
```

Pass `paperBetUseCase` and `paperBetRepo` into the HTTP composition root (the same place `predictionMarketBetUseCase` is passed today).

The on-chain `PredictionMarketBetUseCase` remains instantiated and wired — we are not deleting it. The capability registry entries for `PlaceBetCapability` and `ClosePositionCapability` also remain. They are simply unreachable from the broadcast deep-link after Part 4 lands.

## Env additions — `predictionMarketEnv.ts`

```ts
paperStakeMinUsdcCents: parseIntEnv('PREDICTION_MARKETS_PAPER_STAKE_MIN_USDC_CENTS', 100),
paperStakeMaxUsdcCents: parseIntEnv('PREDICTION_MARKETS_PAPER_STAKE_MAX_USDC_CENTS', 100_000),
paperPriceTtlMs: parseIntEnv('PREDICTION_MARKETS_PAPER_PRICE_TTL_MS', 15_000),
```

(`paperPriceTtlMs` is consumed by Part 3, but lives next to the related env keys for clarity.)

Document in `.env.example` and `be/STATUS.md` env table.

## Tests

`be/src/__tests__/predictionMarketPaperBetUseCase.test.ts`:

- Happy path: finding loaded, price fetched, row inserted with correct `sharesE6`.
- Stake below min / above max → `ValidationError`.
- Polymarket returns `priceBps=0` → `ValidationError('price-unavailable')`, no row inserted.
- Finding missing → `NotFoundError`.
- `detectorSource` correctly set to `'deterministic'` when cluster has `derivedSubject`, `'llm'` otherwise.
- `pickMarketForSide` mapping unit-tested for each pattern type with a fixture covering all five rows of the mapping table.

Mock `IPolymarketAdapter.getTopForSide` and the two repo methods. Don't touch the DB in this test — Part 1 already has integration coverage.

## Acceptance

- `curl -X POST /predictionMarket/paperBet -d '{"findingId":"<real>","side":"A","stakeUsdcCents":1000}'` returns 200 with a row.
- A row exists in `prediction_market_paper_bets` with `entry_price_bps` matching the live CLOB top-of-book at the moment of the call (verify with a parallel direct CLOB query).
- `GET /predictionMarket/paperBets` returns the bet.
- `GET /predictionMarket/paperPerformance?groupBy=overall` returns `[{ key:'overall', betCount:0, ... }]` (no resolved bets yet — that's Part 3).
- No regressions in existing `/predictionMarket/*` routes.

## Logging fields introduced

- `paperBetId` (PK of new table)
- `priceBps` (already used elsewhere, just reaffirming convention)
- `stakeUsdcCents`
