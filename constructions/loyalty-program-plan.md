# Loyalty Program — Backend Plan

## Goal

Award off-chain "points" to users for in-app actions (swap, send, yield
deposit) using a deterministic multi-factor formula. Points live in
Postgres and are computed on read from an append-only ledger. Onchain
token / Merkle airdrop is deferred to TGE and is **out of scope**.

**Non-goals (v1):** onchain points contract, transferable points, social
profiles on leaderboard, NFT badges, sybil clustering, TGE/claim
contract, integration tests for capability hooks.

## Existing surface (do not re-invent)

- Hexagonal layout: ports under `src/use-cases/interface/{input,output}`,
  impls under `src/use-cases/implementations` and
  `src/adapters/implementations/output/sqlDB/repositories`. Match the
  existing `IYieldRepository` / `DrizzleYieldRepository` shape.
- DI: `src/adapters/inject/assistant.di.ts` — lazy singleton getter per
  use-case (e.g. `getYieldOptimizerUseCase`). Add `getLoyaltyUseCase`
  the same way.
- HTTP routing: extend `httpServer.exactRoutes` table — no new branches.
  Privy auth middleware is already wired for authed routes.
- Telegram capabilities: `adapters/implementations/output/capabilities/`,
  registered via `getCapabilityDispatcher` in `assistant.di.ts`. Slash
  commands routed only through `INTENT_COMMAND` enum at
  `helpers/enums/intentCommand.enum.ts`. Do **not** edit `handler.ts`.
- Logger: `createLogger("loyaltyUseCase")` (camelCase scope per
  STATUS.md). Never use `console.*`.
- Time helper: `newCurrentUTCEpoch()` (seconds). Never inline
  `Math.floor(Date.now()/1000)`.
- Migrations: `npm run db:generate && npm run db:migrate`. Never raw
  SQL against the DB.
- Worker-only jobs: gate with `isWorker()` from `helpers/env/role.ts`.
- Redis cache key prefix convention: `loyalty:*` (mirror `yield:*`).

## Resolved decisions (from review)

1. **`users.status` extension.** Replace any boolean flag idea with a
   string column constrained by a TS enum. New values:
   `USER_STATUSES.NORMAL` (default), `USER_STATUSES.FLAGGED`,
   `USER_STATUSES.FORBIDDEN`. Existing values
   (`ACTIVE/BLOCKED/DELETED/NEED_VERIFICATION/WAITING_FOR_VERIFICATION`)
   serve a different axis (account lifecycle) — agent should evaluate
   whether to merge axes or add a new `loyalty_status` column. **Default
   recommendation:** add a new column `loyalty_status text NOT NULL
   DEFAULT 'normal'` to keep concerns separate. DB type is `text`,
   enforced in TS as `LOYALTY_STATUSES` enum.
2. **Repo tests skipped for v1.** Only `loyalty.formula.test.ts` and
   `loyalty.usecase.test.ts` (with stubbed repo) ship. No Postgres
   harness work.
3. **`yield_hold_day` daily award is a behavioral expansion**, not a
   plain hook. If PR 3 grows in scope, defer it — note in STATUS.md
   that loyalty for yield holding is intentionally not awarded yet.
4. **Active-season cache** lives in Redis (`loyalty:season:active`,
   60s TTL), not in-process. Solves multi-replica staleness.
5. **Action-type and season-0 seeding** done via the migration file
   (drizzle migrations support `INSERT`s), not a runtime seeder.
6. **Leaderboard cache** in Redis from PR 2
   (`loyalty:leaderboard:{seasonId}`, 30–60s TTL) to avoid SUM-GROUP-BY
   on every public hit.

## Data model

Three new tables + one column on `users`.

### `users.loyalty_status` (new column)

```
loyalty_status  text NOT NULL DEFAULT 'normal'
```

TS enum `LOYALTY_STATUSES = { NORMAL: 'normal', FLAGGED: 'flagged',
FORBIDDEN: 'forbidden' }` in `helpers/enums/`. Drizzle column typed
through this enum. `flagged` users still accrue ledger rows but
`getBalance` / `getLeaderboard` return 0 / null. `forbidden` users
short-circuit `awardPoints` (no row written).

### `loyalty_action_types`

```
id                text PK              -- e.g. 'swap_same_chain'
display_name      text NOT NULL
default_base      bigint NOT NULL
is_active         boolean NOT NULL DEFAULT true
created_at_epoch  bigint NOT NULL
```

Seven seeded rows in the migration: `swap_same_chain`, `swap_cross_chain`,
`send_erc20`, `yield_deposit`, `yield_hold_day`, `referral`,
`manual_adjust`.

### `loyalty_seasons`

```
id                  text PK              -- e.g. 'season-0'
name                text NOT NULL
starts_at_epoch     bigint NOT NULL
ends_at_epoch       bigint NOT NULL
status              text NOT NULL        -- 'pending' | 'active' | 'closed'
formula_version     text NOT NULL        -- 'v1'
config_json         jsonb NOT NULL
created_at_epoch    bigint NOT NULL
updated_at_epoch    bigint NOT NULL
```

`config_json` shape (Zod-validated at the repo boundary):

```ts
type SeasonConfig = {
  globalMultiplier: number;
  perActionCap: number;
  dailyUserCap: number | null;
  actionBase: Record<string, number>;
  actionMultiplier: Record<string, number>;
  actionMinUsd: Record<string, number>;
  volume: { formula: 'sqrt' | 'log' | 'linear'; divisor: number };
};
```

Constraint enforced in the use-case (not via partial unique index): at
most one row with `status='active'`.

Migration inserts `season-0` with `status='active'`,
`formula_version='v1'`, `globalMultiplier: 3.0`, `perActionCap: 10000`,
`volume: { formula: 'sqrt', divisor: 10 }`.

### `loyalty_points_ledger`

Append-only. Source of truth.

```
id                    text PK
user_id               text NOT NULL FK -> users.id
season_id             text NOT NULL FK -> loyalty_seasons.id
action_type           text NOT NULL FK -> loyalty_action_types.id
points_raw            bigint NOT NULL
intent_execution_id   text NULL FK -> intent_executions.id
external_ref          text NULL
formula_version       text NOT NULL
computed_from_json    jsonb NOT NULL
metadata_json         jsonb NULL
created_at_epoch      bigint NOT NULL
```

Indices:
- `(user_id, season_id)`
- `(season_id, points_raw DESC)`
- Unique `(intent_execution_id)` WHERE NOT NULL
- Unique `(user_id, action_type, external_ref)` WHERE external_ref NOT NULL

No `loyalty_points_balances` table. Computed via `SUM`. Add a
materialized view later if leaderboard latency demands it.

## The formula

Pure function in `src/helpers/loyalty/pointsFormula.ts`. No I/O.

```ts
export type PointsInput = {
  actionType: string;
  usdValue?: number;
  userMultiplier?: number;
};

export function computePointsV1(
  input: PointsInput,
  season: SeasonConfig,
  actionDefaults: { defaultBase: number },
): { points: bigint; breakdown: ComputeBreakdown };
```

Math:

```
base       = season.actionBase[actionType] ?? actionDefaults.defaultBase
volFactor  = usdValue ? sqrt(usdValue / season.volume.divisor) : 1
actionMult = season.actionMultiplier[actionType] ?? 1
raw        = base * volFactor * actionMult * season.globalMultiplier * userMultiplier
capped     = min(raw, season.perActionCap)
points     = max(round(capped), 1)
```

If `usdValue < season.actionMinUsd[actionType]`, return `points = 0n`
and skip insert at the use-case layer.

Versioning: when math changes, ship `computePointsV2` alongside V1 and
bump the season's `formula_version`. Old ledger rows stay correct
because the version is recorded per row.

## Use-case API

```ts
interface ILoyaltyUseCase {
  awardPoints(input: AwardPointsInput): Promise<LedgerEntry | null>;
  getBalance(userId: string, seasonId?: string): Promise<{
    seasonId: string;
    pointsTotal: bigint;
    rank: number | null;
  }>;
  getHistory(userId: string, opts: {
    seasonId?: string;
    limit: number;
    cursorCreatedAtEpoch?: number;
  }): Promise<LedgerEntry[]>;
  getLeaderboard(seasonId: string, limit: number): Promise<{
    entries: { userId: string; pointsTotal: bigint; rank: number }[];
    seasonId: string;
  }>;
  adjustPoints(input: AdjustInput): Promise<LedgerEntry>;
}
```

`awardPoints` flow:
1. Short-circuit if `users.loyalty_status === 'forbidden'`.
2. Look up active season from Redis cache (`loyalty:season:active`,
   TTL 60s); fall back to DB on miss; refresh cache.
3. Look up action type defaults.
4. Skip if `usdValue < actionMinUsd[actionType]`.
5. Run formula.
6. If `dailyUserCap` set, `SUM(points_raw) WHERE user_id=$1 AND
   created_at_epoch >= today_start_utc`; clamp or skip per config.
7. Insert ledger row.
8. Return.

**Failure rule (non-negotiable):** awards are wrapped in try/catch at
each call site. `loyalty.award.failed` log + metric on error. The host
transaction continues regardless. Add a unit test that injects a
thrown error in the loyalty mock and asserts `SwapCapability` returns
success.

## Integration points

| Call site | When | actionType | usdValue source |
|---|---|---|---|
| `SwapCapability.run` after final `signingRequestUseCase.waitFor` | swap done | `swap_same_chain` / `swap_cross_chain` | Relay quote |
| `SendCapability` after sign confirms | send done | `send_erc20` | **flat base, no usdValue** (no oracle) |
| `YieldOptimizerUseCase.finalizeDeposit` after row written | deposit done | `yield_deposit` | USDC = $1 |
| `YieldReportJob` daily | `yield_hold_day` | **deferred — see below** |
| Admin endpoint (out of scope v1) | referral / manual | `referral_*` / `manual_adjust` | n/a |

**Yield-hold-day deferral.** `YieldReportJob` is currently read-only and
informational. Adding a daily `yield_hold_day` award is a behavioral
expansion, not a hook. If PR 3 is at risk, ship without it and document
in STATUS.md: "v1 does not award points for yield holding; only for
deposits."

**Token USD pricing.** No price oracle in v1. USDC = $1 (yield).
Swaps reuse Relay's price. Sends earn flat base only (no volume bonus).
Multi-stable / oracle deferred until multi-stable yield ships.

## HTTP surface

Three new routes, added to `httpServer.exactRoutes`:

| Method | Route | Auth |
|---|---|---|
| `GET` | `/loyalty/balance` | Privy |
| `GET` | `/loyalty/history?limit=&cursor=` | Privy |
| `GET` | `/loyalty/leaderboard?limit=` | none (public) |

Leaderboard returns rank + pointsTotal only — never `userId` or wallet
in v1. Cached in Redis (`loyalty:leaderboard:{seasonId}`, 30s TTL) to
keep the public SUM-GROUP-BY off the hot path.

No write endpoints from public API.

## Telegram surface

New capability `adapters/implementations/output/capabilities/loyaltyCapability.ts`,
registered in `assistant.di.ts` via `getCapabilityDispatcher`.

| Command | Behavior |
|---|---|
| `/points` | active season balance, rank, last 5 ledger entries |
| `/leaderboard` | top 10 of active season (rank + anonymized id + points) |

Add `INTENT_COMMAND.POINTS` and `INTENT_COMMAND.LEADERBOARD` to
`helpers/enums/intentCommand.enum.ts`. Exclude both from
`SendCapability` routing (same pattern as `/yield`, `/withdraw`).

`/points` message template:

```
🪙 Points — Season 1
Balance: 1,247
Rank: #482

Recent activity:
• swap (cross-chain) +88 — 2h ago
• yield deposit       +340 — yesterday
• swap (same-chain)   +12 — yesterday
• send                +1 — 2d ago

Tip: yield deposits earn the most points.
```

## Anti-farming (v1)

1. `perActionCap` (per single award).
2. `dailyUserCap` (optional, per user per UTC day).
3. `actionMinUsd[actionType]` — sub-threshold awards skipped.
4. Idempotency via `intent_execution_id` unique index.
5. `loyalty_status='flagged'` suppresses balance/leaderboard but
   preserves ledger; `forbidden` blocks awards entirely. Reversible
   via column update. Clawbacks via `adjustPoints` (signed `points_raw`).

Sybil clustering / wash-trade / behavioral analysis deferred.

## Observability

Logger:

```ts
const log = createLogger("loyaltyUseCase");
```

Mandatory log lines:
- `info` `{ step: 'awarded', userId, actionType, points, intentExecutionId }`
- `info` `{ step: 'capped', userId, actionType, raw, capped }`
- `info` `{ step: 'skipped_min_usd', userId, actionType, usdValue }`
- `debug` `{ choice: 'season-cache-hit' | 'season-cache-miss' }`
- `error` `{ err, userId, actionType, intentExecutionId }`

Metrics (extend `MetricsRegistry`):
- `loyalty_awards_total{action,outcome}` counter
- `loyalty_award_duration_ms` histogram
- `loyalty_points_awarded_total{action}` counter

## Configuration / env

Zero new required env vars. All tunable knobs live in
`loyalty_seasons.config_json`.

Optional (with defaults):

| Variable | Default | Purpose |
|---|---|---|
| `LOYALTY_ACTIVE_SEASON_CACHE_TTL_MS` | `60000` | Redis season cache |
| `LOYALTY_LEADERBOARD_CACHE_TTL_MS` | `30000` | Redis leaderboard cache |
| `LOYALTY_LEADERBOARD_DEFAULT_LIMIT` | `100` | HTTP default |
| `LOYALTY_LEADERBOARD_MAX_LIMIT` | `1000` | Hard cap |

All hoisted to top-of-file consts. Group in `helpers/env/loyaltyEnv.ts`
matching `yieldEnv.ts` pattern.

## Tests (v1)

Black-box, Node `test` runner, `npx tsx --test tests/*.test.ts`.

- `loyalty.formula.test.ts` — ≥15 cases covering base × multipliers,
  sqrt curve at $1/$10/$100/$10k/$1M, per-action cap clamping, global
  multiplier, floor-at-1, missing `usdValue` → flat base, sub-min
  threshold skip.
- `loyalty.usecase.test.ts` — happy path, idempotency on
  `intent_execution_id`, daily-cap enforcement, no-active-season error,
  loyalty-failure-doesn't-break-host (inject thrown error in mock,
  assert host call still resolves).

**Repo tests skipped for v1** (no Postgres test harness exists). Add
when the harness lands.

## Phased rollout

**PR 1 — Foundation.**
- Schema (3 tables + `users.loyalty_status` column) + migration with
  seeded action types and `season-0`.
- `LOYALTY_STATUSES` enum, `INTENT_COMMAND.POINTS/LEADERBOARD` enum
  entries reserved.
- `ILoyaltyUseCase` + impl, repo ports + Drizzle impls.
- `pointsFormula.ts` + tests.
- DI wiring.
- No call sites, no HTTP, no Telegram.

**PR 2 — Integration.**
- Hooks into `SwapCapability`, `SendCapability`,
  `YieldOptimizerUseCase.finalizeDeposit`.
- HTTP routes (`/balance`, `/history`, `/leaderboard`) + Redis
  leaderboard cache.
- Metrics.

**PR 3 — Telegram + polish.**
- `LoyaltyCapability` (`/points`, `/leaderboard`).
- `YieldReportJob` daily `yield_hold_day` award **only if scope allows**;
  otherwise defer and document.
- Final review, STATUS.md update.

## Definition of done (v1)

- [ ] Migration applied; 3 tables + `users.loyalty_status` column
- [ ] `season-0` row exists, status='active', `globalMultiplier: 3.0`
- [ ] Seven action types seeded
- [ ] `awardPoints` called from Swap, Send, Yield-deposit
- [ ] Awards idempotent on `intent_execution_id`
- [ ] Loyalty failures never break host (verified by test)
- [ ] `GET /loyalty/balance|history|leaderboard` work end-to-end
- [ ] `/points` and `/leaderboard` Telegram commands work
- [ ] `/metrics` exposes the three new metric names
- [ ] Formula unit tests pass (≥15 cases)
- [ ] At least one real point awarded on staging from each of the three
      live hook points
- [ ] STATUS.md updated under `## Loyalty program — <date>` section,
      including the explicit note about yield-hold-day deferral if it
      did not ship
