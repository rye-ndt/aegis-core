# Onchain Agent — Status

## Healthcheck endpoint — 2026-04-25

**What:** Added `POST /health` to `HttpApiServer` (`src/adapters/implementations/input/http/httpServer.ts`). Unauthenticated; returns insensitive deployment metadata: `status`, `service`, `version` (from `SERVICE_VERSION` env), `processRole`, `nodeEnv`, `runtime` (node/platform/arch), `chain` (id/name/nativeSymbol via `CHAIN_CONFIG`), `uptimeSeconds`, `startedAtEpoch`, `timestampEpoch`, `memoryMb` (rss/heapUsed/heapTotal/external), and a `services` boolean map showing which optional use cases/repos were wired into the constructor.

**Why:** Need a single deployment-verification probe that confirms the bundle booted, identifies which `PROCESS_ROLE` is responding, and signals which optional dependencies are wired without revealing secrets, addresses, RPC URLs, or env values. Chose POST per request even though the handler is read-only — easier to gate behind a simple body filter later if needed without changing the route shape. Surfaces a `services` map (booleans only — names, not values) because the constructor takes 17 optional deps; without this you can't tell from outside whether e.g. the loyalty or yield path is live in a given deployment.

**Sensitive fields explicitly NOT included:** RPC URLs, contract addresses, env var values, METRICS_TOKEN, any user-scoped data, queue depths or pending counts (could leak load patterns). `version` falls back to `"unknown"` if `SERVICE_VERSION` isn't set — wire it at deploy time if you want it populated.

**Side effects to watch:** None functional. Adds one `startedAtEpoch` field captured at server construction (was previously inferable only via `process.uptime()`).

## Dockerfile — esbuild single-bundle rewrite — 2026-04-25

**What:** Replaced the Alpine + `tsc` + full `node_modules` image with a Debian-slim + esbuild single-bundle pipeline. New `src/entrypoint.ts` statically dispatches to `migrate` then one of `workerCli` / `httpCli` / `telegramCli` based on `PROCESS_ROLE`. One bundle (`dist/server.js`), one tiny runtime `node_modules` containing only the externals.

**Why:** Old image was ~225 MB and shipped the full prod `node_modules` (viem, openai, telegram, drizzle, etc.) plus dead artifacts the inline `find` cleanup tried to scrub. Bundling tree-shakes per-entrypoint and dedupes shared deps. Slim base avoids Alpine's musl recompilation pain for native deps.

**Builder needs gyp toolchain.** `telegram` (gramJS) pulls in transitive `websocket`, which nests its own `utf-8-validate` and runs `node-gyp` at install time. The builder stage installs `python3 make g++`; the runtime stage does not. Don't drop the apt layer.

**Externals (must NOT be bundled):**
- `pino`, `thread-stream`, `sonic-boom`, `pino-std-serializers` — pino uses `worker_threads` + dynamic transport require; bundling breaks transports and can break `worker_threads` paths.
- `bufferutil`, `utf-8-validate` — optional native peers of `ws` (ship JS fallback).
- `pg-native`, `pg-cloudflare` — optional `pg` peers; not used.

If you add a new dep that does any of: dynamic `require(variable)`, reads files via its own `__dirname`, or has a `.node` binary — add it to the externals list AND to the runtime-modules copy loop in the Dockerfile.

**Conventions introduced:**
- `src/entrypoint.ts` is THE production entrypoint. The four CLIs (`migrate.ts`, `workerCli.ts`, `httpCli.ts`, `telegramCli.ts`) remain valid `tsx` dev targets but are no longer build outputs — only `dist/server.js` is shipped.
- `esbuild` is installed inline in the builder stage at a pinned version. Promote to `devDependencies` if you want lockfile-tracked reproducibility.
- Runtime image carries sourcemaps; `NODE_OPTIONS=--enable-source-maps` is set so stack traces map back to TS.

**Side effects to watch:**
- `db:migrate` script in `package.json` still references `ts-node src/migrate.ts` — unchanged, dev-only.
- `LOG_PRETTY=true` in prod requires `pino-pretty` in the runtime modules — currently NOT copied (it's a devDep). Don't enable `LOG_PRETTY` in the container without adding it.
- Cloud Run `PORT` → `HTTP_API_PORT` remap moved from the old shell `CMD` into `entrypoint.ts`.

## Loyalty Program — 2026-04-25

Full implementation of the Season 0 loyalty/points system (foundation + integrations + Telegram UI). First cut was reviewed and patched the same day — see "Review fixes" below before assuming the original spec applies.

**What was done:**
- Schema: 3 new tables (`loyalty_seasons`, `loyalty_action_types`, `loyalty_points_ledger`) + `users.loyalty_status` column. Migration at `drizzle/0020_flippant_living_mummy.sql` — seeds 7 action types + `season-0` (active, `globalMultiplier: 3.0`) inline via `INSERT … ON CONFLICT DO NOTHING`. No separate seed script.
- Formula: `computePointsV1` in `src/helpers/loyalty/pointsFormula.ts` — deterministic multi-factor: `base × volFactor × actionMult × globalMult × userMult`, capped at `perActionCap`, floored at 1, returns `0n` (caller skips insert) when below `actionMinUsd`. `SeasonConfig` validated via Zod at the repo boundary.
- Ports (hexagonal-compliant):
  - `src/use-cases/interface/input/loyalty.interface.ts` — `ILoyaltyUseCase`, `AwardPointsInput`, `AdjustInput`, `BalanceView`, `LeaderboardView`.
  - `src/use-cases/interface/output/repository/loyalty.repo.ts` — `ILoyaltyRepository`, `LedgerEntry`, `NewLedgerEntry`, `LoyaltySeason`, `LoyaltyActionType`.
- Use case: `LoyaltyUseCaseImpl` (`src/use-cases/implementations/loyaltyUseCase.ts`) with forbidden/flagged short-circuits, **idempotency on `intent_execution_id` via pre-check + unique-violation catch returning the existing entry**, active-season Redis cache (60s), daily user cap enforcement, leaderboard Redis cache (30s, **keyed by `seasonId:limit`**).
- Repo adapter: `DrizzleLoyaltyRepo` at `src/adapters/implementations/output/sqlDB/repositories/loyalty.repo.ts`. Hung off `DrizzleSqlDB.loyaltyRepo` like all other repos. `SUM(points_raw)` for balance; rank via subquery; `findByIntentExecutionId` for idempotency lookup.
- HTTP routes (Privy auth except leaderboard which is public):
  - `GET /loyalty/balance` → `{ seasonId, pointsTotal: string, rank: number|null }`.
  - `GET /loyalty/history?limit=&cursorCreatedAtEpoch=` → `{ entries: { actionType, points: string, createdAtEpoch }[], nextCursor: number|null }`.
  - `GET /loyalty/leaderboard?limit=&seasonId=` → `{ seasonId, entries: { rank, pointsTotal: string }[] }`. Defaults `seasonId` to active season via `getActiveSeasonId()` (no hardcoded `season-0`).
- Telegram: `LoyaltyCapability` handles `/points` and `/leaderboard` (anonymised — rank + truncated id + points; no full userId/wallet). Uses `triggers.commands[]` plural form. Time helper uses `newCurrentUTCEpoch()`. Markdown-friendly formatting (no `padEnd`/`padStart` — relies on Telegram bold/italic).
- Integration hooks (all wrapped in `void capability?.awardPoints(...).catch(() => undefined)`; the use-case itself never throws — failures log + emit metric + return null):
  - `SwapCapability.run` — after all `signingRequestUseCase.waitFor` resolve; emits `swap_same_chain` or `swap_cross_chain`. **`usdValue: undefined`** (Relay quote not currently surfaced into the capability) → flat-base points in v1.
  - `SendCapability` — emits `send_erc20` on `requestExecution` submission (only for `/send` command, not buy/swap variants). **Awards on submit, not confirm** (no clean post-confirm hook exists; see "Plan deviations" below).
  - `YieldCapability` (deposit) — emits `yield_deposit` with `usdValue ≈ amountRaw / 10^decimals` (USDC ≈ $1) after `finalizeDeposit`.
  - `yield_hold_day` — **not yet wired**. Requires a daily worker-only cron pass per user with active positions. Deferred per plan §3.
- Metrics: `metricsRegistry.recordLoyaltyAward(action, outcome, points?, durationMs?)`. Outcomes: `awarded`, `duplicate`, `forbidden`, `no_season`, `inactive_action`, `below_min_usd`, `daily_cap`, `error`. Exposed under `snapshot().loyalty`.
- Tests: 16 formula tests + 13 use-case tests in `tests/loyalty.*.test.ts`. Repo integration tests deferred (no Drizzle test harness exists).
- Env vars (all optional, hoisted in `src/helpers/env/loyaltyEnv.ts`): `LOYALTY_ACTIVE_SEASON_CACHE_TTL_MS=60000`, `LOYALTY_LEADERBOARD_CACHE_TTL_MS=30000`, `LOYALTY_LEADERBOARD_DEFAULT_LIMIT=100`, `LOYALTY_LEADERBOARD_MAX_LIMIT=1000`.

**Conventions introduced:**
- `TriggerSpec.commands?: INTENT_COMMAND[]` — multi-command capabilities use this instead of registering N singleton instances. `CapabilityRegistry.register()` indexes commands from both `command` and `commands`. Existing single-command capabilities keep using `command`.
- Loyalty awards must always be fire-and-forget at the call site (`void useCase?.awardPoints(...).catch(() => undefined)`). The use-case has its own internal try/catch that logs + emits a metric — the outer `.catch` is just defence in depth. Host transactions never depend on loyalty success.
- New action types: add row to `loyalty_action_types` (DB) **and** add a label entry to the `ACTION_LABELS` map in `loyaltyCapability.ts` and the FE `PointsTab.tsx`. The seven canonical types are: `swap_same_chain`, `swap_cross_chain`, `send_erc20`, `yield_deposit`, `yield_hold_day`, `referral`, `manual_adjust`.
- New `loyalty_status` axis on `users` (separate from existing `status` lifecycle). Values via `LOYALTY_STATUSES` enum: `normal` (default), `flagged` (suppress balance/leaderboard but keep accruing), `forbidden` (block awards entirely). Changeable with a single UPDATE; reversible.
- `loyalty:*` Redis key prefix (mirrors `yield:*`). Active season at `loyalty:season:active`; leaderboard at `loyalty:leaderboard:{seasonId}:{limit}`.
- `getActiveSeasonId()` on `ILoyaltyUseCase` is the canonical way to resolve the active season from outside the use-case (e.g. HTTP handlers). Do **not** call `getBalance("")` to fish out the season id.

### Review fixes (same-day, 2026-04-25)

The first cut was reviewed and the following were corrected before merge:

1. **Migration didn't seed.** Original had a separate `drizzle/seed/loyalty.ts` script that nothing invoked — fresh DB had no active season → every `awardPoints` returned null. Inlined the action-type rows + Season 0 row into the migration with `INSERT … ON CONFLICT DO NOTHING`. Seed script deleted.
2. **HTTP `/loyalty/history` wire shape didn't match the FE.** Was returning `pointsRaw` (FE expects `points`), missing `nextCursor`, and accepting `?cursor=` while FE sends `?cursorCreatedAtEpoch=`. All three fixed; `nextCursor` is derived as `entries.length === limit ? last.createdAtEpoch : null`.
3. **`/loyalty/leaderboard` hardcoded `seasonId` to `"season-0"`.** Now defaults to `loyaltyUseCase.getActiveSeasonId()`; returns `{ seasonId: null, entries: [] }` when no season is active.
4. **`getSumPointsToday` used `gt` (strict `>`).** Entries created exactly at midnight UTC were excluded from the daily cap. Fixed to `gte`.
5. **`getLeaderboard` Redis cache key omitted `limit`.** First call with limit=10 poisoned subsequent limit=100 calls. Cache key now `loyalty:leaderboard:{seasonId}:{limit}`.
6. **Idempotency on `intent_execution_id` was logged as an error.** Plan said: return the existing record. Now does a pre-check via `findByIntentExecutionId`, and additionally catches PG error code `23505` on insert (race window) to return the existing row. Counted under metric outcome `duplicate`, not `error`.
7. **`LoyaltyCapability.formatRelativeTime` used `Math.floor(Date.now()/1000)`.** Replaced with `newCurrentUTCEpoch()` per project convention. `<60s` now renders as `just now` instead of `0m ago`.
8. **Telegram alignment via `padEnd`/`padStart` didn't render** (Telegram is non-monospace). Switched to bold/italic markdown styling.
9. **Hexagonal port location violation.** Original placed ports in `use-cases/interface/loyalty/` (`ILoyaltyUseCase.ts`, `ILoyaltyRepository.ts`) and the Drizzle adapter in `adapters/implementations/output/loyalty/`. CLAUDE.md mandates the existing convention: ports in `interface/input/` + `interface/output/repository/`, repo adapters under `sqlDB/repositories/`, lowercase dot-suffixed filenames. All three moved + renamed (`loyalty.interface.ts`, `loyalty.repo.ts`); old `loyalty/` directories deleted.
10. **Dead code purged**: `void id` in `adjustPoints`, unused `loyaltyUseCase?: ILoyaltyUseCase` injection in `YieldOptimizerDeps` (never read in the file), `void sql;` in the seed script.
11. **Inconsistent `breakdown` for sub-min-USD skip.** Was returning `actionMult: 0` and `volFactor: 0` while keeping a real `base` — confusing for support audits. Now returns the real `actionMult`/`globalMult`, zeroes only `volFactor` and `raw`/`capped`.
12. **`loyalty_points_ledger.points_raw` index was ASC.** Changed to `DESC` to match leaderboard query order; reflected in both `schema.ts` and the migration.

### Plan deviations (intentional, documented in case scope grows)

1. **SwapCapability passes `usdValue: undefined`** — Relay's per-step USD pricing isn't currently surfaced into `RelaySwapToolOutputData`. v1 awards flat base × global multiplier; volume bonus reactivates once Relay USD is plumbed through.
2. **SendCapability awards on submission, not confirmation.** The capability returns `noop` after `requestExecution` is enqueued; there is no in-process post-confirm callback today (signing happens out-of-band via the mini-app). Failed sends will award 1 point each — acceptable while send is the lowest-weight action. Revisit if abuse appears or when a webhook/post-confirm hook lands.
3. **`yield_hold_day` not awarded.** Requires a daily worker-only pass over active positions; deferred per plan §3.
4. **No HTTP write endpoints** for `adjustPoints` (admin clawbacks). The method exists on the use-case but is unreachable from outside. Wire when admin tooling lands.

## Structured logging (pino) — 2026-04-24

Replaced all `console.*` calls across `src/` with structured pino logging via a singleton helper at `src/helpers/observability/logger.ts`.

**What was done:**
- Installed `pino` (prod dep) and `pino-pretty` (devDep only — never in prod image).
- Created `createLogger(scope)` factory; all modules use `const log = createLogger("scope")` at the top of the file — no DI injection.
- Migrated all 127 `console.*` calls across 29 files to structured log calls.
- Added Step 4 new critical-flow instrumentation: `assistant.usecase.ts` (history-loaded, llm-response, tool-result), `intent.usecase.ts` (parse-start, intent-parsed, calldata-built, vector/ILIKE search), `signingRequest.usecase.ts` (created, resolved, waitFor lifecycle), `capabilityDispatcher.usecase.ts` (resolution choice matched/resumed/default, invoke, collect/run errors), all 4 `cache/redis.*` adapters (hit/miss debug), `yieldPoolRanker.ts` (pool-ranked info + low-liquidity/high-utilization disqualification debug), `yieldOptimizerUseCase.ts` (user-nudged info + idle-scan skip reasons).
- `docker-compose.yml` updated: `LOG_LEVEL=debug`, `LOG_PRETTY=true` on all local services (`app`, `worker`, `api`).

**Conventions:**
- `const log = createLogger("scope")` — one child logger per module, scope is a short camelCase identifier.
- First argument is always a structured object `{ step, choice, err, ... }`, second is a short message string.
- `err` is always a field, never interpolated into the message string.
- `step` key used for output of long procedures (info level); `choice` key for branch decisions (debug level).
- `console.*` is banned everywhere in `src/` except `db/migrate.ts` (Drizzle migration runner must use console for output).
- `LOG_PRETTY=true` is local-dev only; production emits raw JSON (Cloud Logging parses it).
- `LOG_LEVEL` defaults: `info` in production, `debug` otherwise.

**Why helper (not a port/adapter):** Logger is cross-cutting infrastructure like `metricsRegistry` — injecting it as a port would require threading it through every constructor for no abstraction benefit.

## Scaling

- 2026-04-24 — DB pool now `max: 25` (env-tunable via `DB_POOL_MAX`). Total Postgres connection budget = replicas × POOL_MAX + 1 worker pool. Do not raise per-replica POOL_MAX without re-budgeting (8 replicas × 25 = 200; server max_connections should be ≥ 250).
- 2026-04-24 — `IMessageDB.findByConversationId` accepts optional `limit`; assistant chat path caps at `MESSAGE_HISTORY_LIMIT=30` rows (`ORDER BY created_at DESC LIMIT N`, reversed to ascending). Preserves behaviour of the later `.slice(-20)`.
- 2026-04-24 — Global OpenAI concurrency cap via `helpers/concurrency/openaiLimiter.ts` (env `OPENAI_CONCURRENCY`, default 6). Per-replica. Applied at all 5 OpenAI call sites (orchestrator chat, embedding, intentParser, intentClassifier, schemaCompiler ×2).
- 2026-04-24 — Datetime moved out of the system prompt (`assistant.usecase.ts`) and into the user-turn prefix so OpenAI's automatic prompt-prefix caching stays warm. Do not put time-varying content in `systemPrompt` again.
- 2026-04-24 — Privy `verifyTokenLite` now LRU-cached inside the adapter (sha256(token) → `{privyDid}`, TTL 5 min, max 5k entries). In-process only; revoked tokens remain valid in cache for up to `PRIVY_VERIFY_CACHE_TTL_MS`. If finer revocation is ever required, shorten the TTL or move to Redis.
- 2026-04-24 — `IPendingCollectionStore` has a Redis-backed adapter (`pending_collection:{channelId}` keys, TTL = pending.expiresAt). DI picks Redis when `REDIS_URL` is set, otherwise in-memory. `PendingCollection.state` must stay JSON-safe (no Date/BigInt/Buffer) — Redis impl will throw on JSON.stringify otherwise.
- 2026-04-24 — Removed `sessionCache` in-memory map from `TelegramAssistantHandler`. Session is now always read from Postgres (`telegram_sessions` indexed on chat_id). Multi-replica-safe. Cost: one extra PK lookup per Telegram message (~1–3 ms, negligible). Do not reintroduce an in-process cache without addressing cross-replica logout staleness first.
- 2026-04-24 — Split entrypoints: `src/workerCli.ts` (Telegram bot + scheduled jobs; exactly 1 replica) and `src/httpCli.ts` (HTTP API only; N replicas). `src/telegramCli.ts` retained as combined local-dev entry. `PROCESS_ROLE` env (`worker` | `http` | `combined`) gates job startup via `helpers/env/role.ts`. Deploying > 1 worker replica will duplicate Telegram notifications — enforce max-instances=1 on the worker Cloud Run service.
- 2026-04-24 — `/metrics` operator endpoint (bearer-gated via `METRICS_TOKEN`) exposes pgPool saturation, openai p-limit queue depth, LLM p50/p95 + cache hit ratio, and sampled Redis latency. `MetricsRegistry` singleton in `helpers/observability/metricsRegistry.ts`. Use `scripts/watch-metrics.sh` during load tests. `OPENAI_CONCURRENCY` exported from `openaiLimiter.ts` (was private).
- 2026-04-24 — Tavily (5 min) and Relay quote (15 s) responses cached in Redis via `helpers/cache/redisResponseCache.ts`. Keys: `tavily:{sha1(q+limit)}`, `relay_quote:{sha1(user+route+amount+type)}`. Caches are opt-in: adapters skip them when `REDIS_URL` is unset. TTLs env-tunable via `TAVILY_CACHE_TTL_SECONDS` / `RELAY_QUOTE_CACHE_TTL_SECONDS`; tighten Tavily if freshness issues surface, tighten Relay if quote-staleness errors appear.
- 2026-04-24 — `ChainEntry.defaultRpcUrls` is now `string[]` (ordered primary → fallbacks). All viem PublicClients use `fallback([http(u1), http(u2), ...])` with `retryCount: 1`. Env: `RPC_URL_FALLBACKS` (comma-separated) supplements `RPC_URL` at runtime. `getChainRpcUrl` deprecated; prefer `getChainRpcUrls`.
- 2026-04-24 — Production topology: `aegis-worker` (Cloud Run min=max=1, Telegram + jobs) + `aegis-api` (Cloud Run min=2 max=8, HTTP only). Shared Upstash Redis + managed Postgres. Single image, role chosen via PROCESS_ROLE. Local parity: `docker compose --profile scale up` (1 worker + 3 api + nginx). Do not raise aegis-worker beyond 1 replica without first solving job-singleton via Redis locks and grammy webhook-mode migration.
- 2026-04-24 — Removed legacy bot-signed autonomous execution path. Deleted `ZerodevUserOpExecutor`, `IUserOpExecutor` port, `IIntentUseCase.confirmAndExecute`, `GET /intent/:intentId` endpoint, `ViemClientAdapter.walletClient`, and the `BOT_PRIVATE_KEY` env var. The backend **never signs transactions** — all signing is done by each user's delegated session-key pair stored in their Telegram cloud (mini-app), driven through `ISigningRequestUseCase.create` + `waitFor`. If you find a new flow that needs autonomous backend signing, re-approach via the mini-app signing pattern; do not reintroduce a server-side key.

## GET /yield/positions — 2026-04-24

HTTP endpoint (Privy-auth) backing the mini-app's `YieldPositions` component on the Home tab. Returns the user's live on-chain yield positions — protocol, token, current $ value, lifetime PnL, 24h delta, APY — plus aggregate totals.

**Shape** (matches `fe/privy-auth/src/hooks/useAppData.tsx:YieldPositionsData`):
```
{ positions: PositionView[], totals: { principalHuman, currentValueHuman, pnlHuman } }
```
`pnlHuman` / `pnl24hHuman` are signed (`+1.28` / `-0.04`); `principalHuman` / `currentValueHuman` unsigned; all 2-decimals. `apy` is a fraction (FE multiplies by 100).

**Data sources** — read-only, no DB writes:
1. `yieldRepo.listActiveProtocols(userId)` — the index of `(chainId, protocolId, tokenAddress)` tuples to check.
2. `adapter.getUserPosition(user, token)` — **live on-chain balance** (`aToken.balanceOf` for Aave v3). Every $ figure the user sees is live, not cached.
3. `yieldRepo.getPrincipalRaw(...)` — cost basis (deposits − withdrawals) for lifetime PnL.
4. `snapshots` row with `snapshotDateUtc === yesterday` for the 24h delta baseline. If no snapshot exists yet (user deposited <24h ago) the delta is 0.
5. `adapter.getPoolStatus(token)` — live APY. Called per position; small RPC overhead acceptable because the component only renders a handful of rows.

**Why not store a materialised `yield_positions` table?** Balances drift every block (interest accrual on aTokens). A snapshot table would always be stale; the live read is a single `balanceOf` per position.

**New method**: `IYieldOptimizerUseCase.getPositions(userId): Promise<PositionsView>` — endpoint handler is a thin wrapper so business logic stays in the use-case layer (hexagonal).

**Protocol display names** live in a `PROTOCOL_DISPLAY_NAMES: Record<YIELD_PROTOCOL_ID, string>` map inside `yieldOptimizerUseCase.ts`. Add a line there when registering a new protocol adapter — do not inline display strings at call sites.

**Totals decimals assumption**: current implementation sums all positions into a single total using the last-seen stablecoin's decimals. This is correct for the single-stablecoin (USDC) configuration today; when multi-stablecoin ships, totals need per-symbol grouping or USD-normalisation (flagged in code comment).

## /yield + /withdraw — proactive USDC yield optimizer — 2026-04-24

New feature: proactive yield optimizer for idle USDC on Avalanche mainnet using Aave v3.

**What was built (per `constructions/yield-optimization-plan.md`):**

- **3 new DB tables** (`yield_deposits`, `yield_withdrawals`, `yield_position_snapshots`) — drizzle migration `0018_ordinary_toxin.sql` applied.
- **4 new ports** under `use-cases/interface/yield/`: `IYieldProtocolAdapter`, `IYieldProtocolRegistry`, `IYieldPoolRanker`, `IYieldRepository`, `IYieldOptimizerUseCase`.
- **Aave v3 adapter** (`adapters/implementations/output/yield/aaveV3Adapter.ts`): `getPoolStatus` (ray→APY from `PoolDataProvider.getReserveData`), `buildDepositTx` (approve if needed + supply), `buildWithdrawAllTx` (withdraw maxUint256), `getUserPosition` (aToken balanceOf).
- **Ranking** (`use-cases/implementations/yieldPoolRanker.ts`): `score = 0.7 * EMA_7d(supplyApy) + 0.3 * currentSupplyApy`; disqualify if liquidityUSD < $100k; 0.5× penalty if utilization > 95%.
- **3 background jobs**:
  - `YieldPoolScanJob` — scans Aave pool every 2h (env: `YIELD_POOL_SCAN_INTERVAL_MS`), writes winner to `yield:best:{chainId}:{token}` (3h TTL), maintains 84-sample APY series per protocol.
  - `UserIdleScanJob` — scans active users every 24h (env: `YIELD_USER_SCAN_INTERVAL_MS`), checks idle USDC balance vs threshold, sends Telegram nudge with inline keyboard.
  - `YieldReportJob` — ticks every 5 min, fires once per day at configured UTC hour (`YIELD_REPORT_UTC_HOUR`, default 9), sends daily PnL report per user.
- **`YieldCapability`** — handles `/yield` (nudge keyboard), `/withdraw` (full exit), and `yield:opt:*`, `yield:custom`, `yield:skip` callbacks. Deposit/withdraw flow reuses the `ISigningRequestUseCase.create` + `waitFor` pattern from SwapCapability.
- **`YieldOptimizerUseCase`** — `runPoolScan`, `scanIdleForUser`, `buildDepositPlan`, `finalizeDeposit`, `buildWithdrawAllPlan`, `buildDailyReport`.
- **`listActiveUserIds()`** added to `ITelegramSessionDB` and its Drizzle impl.
- `INTENT_COMMAND.YIELD` and `INTENT_COMMAND.WITHDRAW` added to enum; excluded from SendCapability routing.
- `YIELD_ENV` helper (`helpers/env/yieldEnv.ts`) — all yield env vars parsed once at startup.
- Avalanche mainnet yield config in `chainConfig.ts`: native USDC `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`, Aave pool `0x794a61358D6845594F94dc1DB02A252b5b4814aD`, data provider `0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654`.

**New env vars:**

| Variable | Default | Purpose |
|---|---|---|
| `YIELD_IDLE_USDC_THRESHOLD_USD` | `10` | Min idle balance to nudge user |
| `YIELD_POOL_SCAN_INTERVAL_MS` | `7200000` | Pool scan frequency |
| `YIELD_USER_SCAN_INTERVAL_MS` | `86400000` | Idle scan frequency |
| `YIELD_REPORT_UTC_HOUR` | `9` | Hour (UTC) to send daily reports |
| `YIELD_NUDGE_COOLDOWN_SEC` | `86400` | Cooldown between nudges per user |
| `YIELD_ENABLED_CHAIN_IDS` | `43114` | Comma-separated chain IDs |

**New Redis keys:**

| Key | Value | TTL |
|---|---|---|
| `yield:best:{chainId}:{token}` | JSON `{protocolId, score, apy, ts}` | 3h |
| `yield:apy_series:{chainId}:{protocolId}:{token}` | List of `{apy, ts}` JSON (84 samples max) | none |
| `yield:nudge_cooldown:{userId}` | `"1"` | `YIELD_NUDGE_COOLDOWN_SEC` |
| `yield:nudge_pending:{userId}` | `"1"` | 48h |
| `yield:report_done:{YYYY-MM-DD}` | `"1"` | 25h |

**Conventions introduced:**

- Yield-specific adapters live under `adapters/implementations/output/yield/`.
- New background jobs follow the `start()`/`stop()` + immediate-run + setInterval pattern from `TokenCrawlerJob`.
- Chunk-based concurrency (`Promise.allSettled` with chunks of N) is the pattern when `p-limit` is unavailable.
- All yield chain/address config belongs in `chainConfig.ts` under `YieldChainConfig`; `getYieldConfig(chainId)` and `getEnabledYieldChains()` are the only access points.
- `YIELD_ENV` in `helpers/env/yieldEnv.ts` is parsed once at module load — never read `process.env` directly in yield code.

**Deferred (must implement before v2 — `/yield` "optimization" degrades without these):**

- **Auto-rebalance** when a better pool appears (and auto-exit on APY drop > threshold). Without this, funds can sit in a stale winner after a better pool emerges.
- **Partial withdrawal** (`/withdraw <pct>` or `/withdraw <amount>`).
- **Multi-stablecoin support** (schema already keyed by token; only USDC is configured).
- **Multi-chain idle scan** (currently scans only first enabled chain).
- **Additional protocol adapters** (Benqi, Yearn). Interface is narrow enough to drop them in.
- **LLM-based adapter dispatch** — current design calls typed methods directly (one protocol → no benefit yet). Reconsider when protocol count grows.
- **Per-user timezone for reports** (one fixed UTC hour today).
- ~~`GET /yield/positions` HTTP endpoint~~ — **shipped 2026-04-24** (see below).
- **Tests** (§12 of plan).

**Review fixes (2026-04-24, same day):**

- Unified `YIELD_PROTOCOL_ID` enum as the single source of truth; removed duplicate `type YieldProtocolId` from `chainConfig.ts`.
- `YieldPoolRanker.rank()` now takes `tokenDecimals` instead of hardcoding `6` — chain-agnostic.
- `YieldReportJob` no longer imports the concrete `YieldOptimizerUseCase` class; `reportDoneRedisKey` is a method on `IYieldOptimizerUseCase`.
- `WithdrawPlan.withdrawals[].balanceRaw` is now piped through; `finalizeWithdrawal` records the actual withdrawn amount so `principalRaw = deposits − withdrawals` is correct and lifetime PnL stays consistent.
- `SignRequest` extended with `kind`, `chainId`, `protocolId`, `tokenAddress`, `displayMeta` (only on step 1). Capability now sets them, so the FE `YieldDepositHandler` actually renders for yield flows instead of falling through to the generic `SignHandler`.
- Nudge keyboard deduplicated — exported `buildNudgeKeyboard()` from the capability, reused in the DI-level auto-nudge.
- Daily-report formatting reads decimals and symbol from `getYieldConfig()` instead of hardcoding `6`/`USDC`.
- Dropped unused `yieldRepo` dep from `YieldCapability` and `UserIdleScanJob`.

## /swap — 2026-04-24

New Telegram command: `/swap`. Relay-backed intent swap with autonomous
execution via the user's session key. Same-chain and cross-chain.

**Flow** (capability-first, mirrors `/send`'s gather pipeline):

1. `SwapCapability` registered in the dispatcher for `INTENT_COMMAND.SWAP`.
2. `collect()` reuses `intentUseCase.compileSchema` + `ResolverEngine` to
   gather `fromTokenSymbol`, `toTokenSymbol`, `readableAmount`, and optional
   `fromChainSymbol` / `toChainSymbol`. Disambiguation on multi-candidate
   symbols uses `buildDisambiguationPrompt` from `send.messages.ts`.
3. `run()` runs the **shared Aegis Guard interceptor** on the origin token
   (`use-cases/implementations/aegisGuardInterceptor.ts` — extracted from
   `SendCapability` to de-duplicate). If insufficient, returns an
   `ApproveRequest` mini-app artifact; user re-runs `/swap` after approving.
4. Calls `RelaySwapTool.execute(...)` which hits `${RELAY_API_URL}/quote`
   and returns the ordered list of transactions to sign.
5. Per step: creates a `SigningRequestRecord` (via new
   `ISigningRequestUseCase.create`), emits a `mini_app` artifact with a
   matching `SignRequest`, then awaits via new `waitFor(requestId, timeoutMs)`
   which polls the `sign_req:{id}` Redis key. Rejection / timeout short-
   circuits the queue.

**No /confirm gate.** Once Aegis Guard passes, the capability schedules
each step directly. Mini-app session key signs everything.

**Chain coverage.** `src/helpers/chainConfig.ts` is now the single source
of truth — added `relayEnabled: boolean` per entry + exported
`RELAY_SUPPORTED_CHAIN_IDS` + `resolveChainSymbol(sym?)` helper. Mainnets
enabled; Fuji disabled (Relay testnet coverage is limited).

**Conventions introduced / enforced:**

- Aegis Guard re-approval logic lives in one place
  (`use-cases/implementations/aegisGuardInterceptor.ts`). `SendCapability`
  and `SwapCapability` both call `checkTokenDelegation(...)`; new autonomous
  flows must do the same rather than inlining.
- New cross-chain port: `IRelayClient` in
  `use-cases/interface/output/relay.interface.ts`. The `RelayClient`
  adapter is a thin `fetch` wrapper; no transport-layer complexity in the
  use-case layer.
- System tools may opt out of `SystemToolProviderConcrete` when they're
  command-path only — `RelaySwapTool` is registered solely through the
  DI factory (`getRelaySwapTool()`), not in the LLM tool registry. The LLM
  sees `execute_intent`, not `relay_swap`.
- `SwapCapability` constructs its `ToolManifest` in-memory (no DB seed).
  Acceptable because the manifest is consumed only by the compile+resolver
  pipeline — Relay supplies calldata, so `buildRequestBody` / solver
  registry are bypassed. Do not "fix" by seeding `tool_manifests`.
- `ISigningRequestUseCase` now exposes `create()` and
  `waitFor(requestId, timeoutMs)`. New multi-step autonomous flows should
  use the same pair rather than fire-and-forget artifacts.
- New optional env var: `RELAY_API_URL` (defaults to `https://api.relay.link`).

**FE continuation endpoint:** `GET /request/:id?after=<prevId>` returns the
next pending `SignRequest` for the authenticated user (privy token required).
Backed by a new `user_pending_signs:<userId>` Redis ZSET maintained by
`RedisMiniAppRequestCache.store/delete`. This is what lets the mini-app stay
open across multi-step swaps instead of closing after every tx. Path `:id`
is ignored when `?after=` is present — it's there for URL symmetry only.

**Convention introduced:** any cache that implements `IMiniAppRequestCache`
must index `SignRequest` entries by `userId` so the continuation endpoint can
look up next-pending without an O(N) Redis scan. New variants that require
the same "what's next for user X" lookup should reuse the ZSET.

**Out of scope (v1):**

- Slippage control (Relay default used).
- Destination-fill polling for cross-chain (Relay's `/intents/status/v2`).

## Capability refactor (phase 2, complete) — 2026-04-23

All steps from `constructions/capability-convergence-plan.md` are now
implemented. Every Telegram flow goes through `ICapabilityDispatcher`. The
legacy branching in `handler.ts` is gone.

**What's in place (phase 2 additions):**

- `CapabilityRegistry.registerDefault(capability)` — catch-all for free text
  with no slash-command match. Callback inputs never route to the default.
- `AssistantChatCapability` — registered as the default. Wraps the existing
  `AssistantUseCase.chat → OpenAIOrchestrator → ITool registry` loop.
  Per-channel conversation id map preserves multi-turn LLM context.
- `SendCapability` — one class, N instances (one per `INTENT_COMMAND` except
  `/buy`). Encapsulates the full `selectTool → compileSchema → resolve →
  disambiguate → buildRequestBody → delegation-check → sign` pipeline,
  including @handle recipient resolution (MTProto + Privy) and Aegis Guard
  re-approval. Session state serialises through `PendingCollectionStore`.
- `send.messages.ts` / `send.utils.ts` — ex-`handler.messages.ts` /
  `handler.utils.ts`, relocated to the output side so adapters don't cross
  the input↔output boundary.

**Telegram handler after phase 2:**

- Now ~200 lines (from 1146). Just an auth gate + dispatcher forwarder.
- Removed: `orchestratorSessions`, `conversations`,
  `pendingRecipientNotifications` maps; every `startCommandSession`,
  `startLegacySession`, `continueCompileLoop`, `runResolutionPhase`,
  `handleDisambiguationReply`, `buildAndShowConfirmation*`,
  `runDelegationCheck`, `tryCreateDelegationRequest`,
  `resolveRecipientHandle`, `handleFallbackChat`, `sendMiniAppButton`,
  `sendApproveButton`, `sendMiniAppPrompt` methods. Constructor now takes
  four args (was 17).
- `handler.types.ts` deleted (`OrchestratorSession` replaced by the
  in-capability `SessionState`, which is plain JSON).

**Tests (`be/tests/`):** 22 black-box tests covering the dispatcher
contract, registry matching rules, pending-store TTL, BuyCapability (all
three paths), and SendCapability's happy / abort / missing-question /
disambiguation paths. Run with `npx tsx --test tests/*.test.ts`.

**Conventions (unchanged but re-affirmed):**

- Adding a new user-facing feature = one Capability + one registry line.
- Do not reach into `handler.ts` to add flow logic — it is intentionally
  thin.
- Capability helpers (message builders, regexes) live next to the
  capability under `adapters/implementations/output/capabilities/`, not
  under input adapters.

## Capability refactor (phase 1) — 2026-04-23

Started the refactor documented in `constructions/capability-convergence-plan.md`.
**Phase 1 shipped**: ports, dispatcher, registry, pending store, Telegram
artifact renderer, and the first migrated capability (`/buy`). `/send` and
the LLM fallback **remain on the legacy handler path** — see below.

**What's in place:**

- `use-cases/interface/input/capability.interface.ts` — `Capability`,
  `Artifact` (discriminated union), `CollectResult`, `TriggerSpec`,
  `CapabilityCtx` (with `emit` for intermediate artifacts).
- `use-cases/interface/input/capabilityDispatcher.interface.ts`
- `use-cases/interface/output/{capabilityRegistry,paramCollector,artifactRenderer,pendingCollectionStore}.interface.ts`
- `use-cases/implementations/capabilityRegistry.ts` — in-memory index by
  id / command / callback-prefix.
- `use-cases/implementations/capabilityDispatcher.usecase.ts` — single
  entry point. Priority: (1) fresh slash-command / callback match, which
  pre-empts and clears any stale pending flow; (2) resume active
  pending-collection; (3) default free-text capability. Typing `/send`
  cancels an unfinished `/buy`, but a bare reply like "8" to a
  disambiguation prompt resumes the pending flow instead of being
  swallowed by the default assistant LLM.
- `adapters/implementations/output/pendingCollectionStore/inMemory.ts` —
  TTL-backed per-channel pending state.
- `adapters/implementations/output/artifactRenderer/telegram.ts` — one
  exhaustive switch that subsumes `sendMiniAppPrompt` /
  `sendMiniAppButton` patterns for any capability output.
- `adapters/implementations/output/capabilities/buyCapability.ts` —
  `/buy` fully migrated. All state (amount pending, yes/no, copy-address
  callback) lives in this one file.
- `adapters/implementations/output/capabilities/assistantChatCapability.ts`
  — scaffold only, **not registered**. Kept for Phase 2.

**Telegram handler changes:**

- Constructor now optionally takes `ICapabilityDispatcher`.
- Text messages: dispatcher gets first look; if it returns `handled: false`,
  fall through to the existing legacy flow (`/send`, disambiguation,
  LLM fallback).
- Callbacks: a single `bot.on("callback_query:data")` forwards everything
  except `auth:login` to the dispatcher, which routes by registered
  `callbackPrefix`.
- Removed: inline `/buy` branches, `startBuyFlow`, `askBuyChoice`,
  `handleBuyOnchainDeposit`, `handleBuyOnrampMoonpay`, `pendingBuyAmount`
  set, module-level `parseBuyAmount`/`formatBuyAmount`. Handler went from
  1146 → 1014 lines.

**What's NOT migrated yet (Phase 2):**

- `/send` command flow — the full compile → resolve → disambig →
  delegation → sign pipeline. Stays on legacy handler methods verbatim.
- Free-text classify-and-route (`startLegacySession` /
  `handleFallbackChat`). Stays on legacy.
- `AssistantChatCapability` exists but is un-wired.

**Why the split:** `/buy` was the safest pilot (small, new code, minimal
deps). `/send` migration needs a live bot to validate 13 interdependent
methods and a multi-turn state machine. Shipped what's verifiable;
deferred what needs eyes-on testing. Reversing the order would have risked
the working `/send` flow.

**Conventions introduced (enforce in new code):**

- Every new user-facing feature is a `Capability` registered via
  `AssistantInject.getCapabilityDispatcher`. Do not add branches to
  `handler.ts`.
- Capabilities return `Artifact`s; rendering is the renderer's job. Do not
  call `bot.api.sendMessage` from a capability.
- Intermediate progress updates go through `ctx.emit(artifact)`. Terminal
  output is the value returned from `run()`.
- Callback routing is by `triggers.callbackPrefix`. Reserve short, unique
  prefixes (`buy`, `send`, …) — the registry throws on collision.
- `pendingCollectionStore` carries `expiresAt` (600s default). Capability
  state must be JSON-serialisable so a future Redis impl is drop-in.
- When adding a default-match fallback (e.g. wiring
  `AssistantChatCapability`), extend `ICapabilityRegistry` explicitly —
  do not special-case it in the dispatcher.
- `ICapabilityRegistry.match()` returns **only** explicit command /
  callback matches (never the default). The dispatcher owns the
  "pending beats default" ordering via `getDefault()`. Do not revive the
  old behaviour of returning the default from `match()` — it causes
  multi-turn replies (e.g. disambiguation "8") to be stolen by the LLM
  and silently clears the pending flow.

## Onramp /buy — 2026-04-23

Added a `/buy <amount>` Telegram command for USDC onramp. **Unlike /send, /buy does NOT go through `intentUseCase.selectTool` / `compileSchema` / tool manifests** — it produces no on-chain calldata, so forcing it through the manifest/solver pipeline would be wrong (`ToolManifestSchema` requires `steps.min(1)`).

**Flow** (all in `adapters/implementations/input/telegram/handler.ts`):

1. `bot.on("message:text")` intercepts `INTENT_COMMAND.BUY` before `startCommandSession`.
2. `startBuyFlow` parses `/buy <amount>` via regex (`parseBuyAmount`). If bare `/buy`, adds chatId to `pendingBuyAmount` set and asks for a number; next plain-number message is captured.
3. `askBuyChoice` sends inline keyboard with two callbacks: `buy:y:<amount>` and `buy:n:<amount>`. No session state needed — the amount rides on the callback payload (Telegram 64-byte limit is ample).
4. `buy:y` → `handleBuyOnchainDeposit` fetches `userProfileRepo.smartAccountAddress` and replies with address + "Copy address" button (callback `buy:copy:<addr>` re-sends the bare address in a mono-formatted message for long-press copy).
5. `buy:n` → `handleBuyOnrampMoonpay` creates an `OnrampRequest` and sends a mini-app web button, identical pattern to `sendMiniAppPrompt`.

**New MiniAppRequest variant** in `use-cases/interface/output/cache/miniAppRequest.types.ts`:
```
OnrampRequest { requestType: 'onramp'; userId; amount; asset; chainId; walletAddress; ... }
```
`RequestType` union extended with `'onramp'`. Cache layer is polymorphic — no consumer switch to update.

**Conventions introduced:**
- A slash command may bypass `selectTool` when it has no on-chain side effect. Do not "fix" this by adding a manifest.
- Callback-query-driven continuations (e.g. `buy:y:<amount>`) are preferred over in-memory follow-up sessions when the state fits in the callback payload.
- Smart-account address is the deposit target (matches `getPortfolio.tool.ts` and the mini-app's "receives funds" label).

**Out of scope:** deposit-watcher notifications, MoonPay webhooks, non-USDC assets.

## Backlog

- Proactive agent: daily market sentiment → investment verdict
- Temporarily disable RAG (speed/correctness); re-enable once tool count grows
- Aegis Guard agent-side enforcement: before submitting any UserOp, re-check `token_delegations.limitRaw - spentRaw` and `validUntil`; call `incrementSpent(userId, tokenAddress, amount)` after confirmed on-chain execution
- Re-enable the OpenAI-backed execution estimator only if the deterministic path proves insufficient; it was removed during cleanup.

## Cleanup 2026-04-23

**Removed** (see `constructions/cleanup-plan.md` for the full map):

- Unused use-case surface: `IAssistantUseCase.{listConversations,getConversation}`, `IIntentUseCase.{getHistory,parseFromHistory,previewCalldata}`, `ISolverRegistry.buildFromManifest`, `IIntentDB.listByUserId`.
- Unused repo methods: `IMessageDB.{findUncompressedByConversationId,markCompressed,findAfterEpoch}`, `IConversationDB.{update,findById,findByUserId,delete,upsertSummary,updateIntent,flagForCompression}`, `ITelegramSessionDB.deleteExpired`, `ITokenDelegationDB.findByUserIdAndToken`.
- Stale columns dropped from `schema.ts` (migration pending): `messages.compressed_at_epoch`, `conversations.{summary,intent,flagged_for_compression}`.
- Orphan files: `output/solver/restful/traderJoe.solver.ts` (threw on call, unregistered), `output/intentParser/openai.executionEstimator.ts` (never wired — deterministic estimator wins), `output/intentParser/intent.validator.ts` (relocated, see below), empty `use-cases/interface/output/sse/` dir.
- Dead env plumbing: `_jwtSecret?: string` parameter on `HttpApiServer` and the `process.env.JWT_SECRET` read in `assistant.di.ts` (auth is Privy-only).

**Conventions enforced:**

- `newUuid()` for the HTTP reqId (was `Math.random()`).
- `newCurrentUTCEpoch()` replaces inline `Math.floor(Date.now() / 1000)` in `httpServer`, `redis.signingRequest`, `delegationRequestBuilder`, `deterministic.executionEstimator`, `auth.usecase`.
- `process.env.*` reads hoisted to top-of-file consts in `openai.intentParser`, `openai.schemaCompiler`, `openai.intentClassifier`, `handler.ts` (`MINI_APP_URL`, `MAX_COMPILE_TURNS`), `delegationRequestBuilder` (`DELEGATION_TTL_SECONDS`), `pangolin.tokenCrawler`, `assistant.usecase` (`MAX_TOOL_ROUNDS`).
- Chain-specific `NETWORK_TO_CAIP2` map in `privy.walletDataProvider` moved into `chainConfig.ts` as `CAIP2_BY_PRIVY_NETWORK`, derived from `CHAIN_REGISTRY` (each entry now carries `privyNetwork`).
- `getTelegramNotifier()` in `assistant.di.ts` is now a cached singleton like all other getters; `getAuthUseCase` reuses it instead of building a second `BotTelegramNotifier`.
- Hexagonal boundary restored:
  - `validateIntent` moved from `adapters/implementations/output/intentParser/intent.validator.ts` to `use-cases/implementations/validateIntent.ts`; `WINDOW_SIZE` now lives in `use-cases/interface/input/intent.errors.ts` so both the use-case and the openai parser import from the interface layer, not from each other.
  - `MiniAppRequest` / `MiniAppResponse` types moved to `use-cases/interface/output/cache/miniAppRequest.types.ts`; the http adapter no longer owns a type that the cache interface depends on.

**Duplicates collapsed:**

- Three near-identical telegram button senders (`sendWelcomeWithLoginButton`, `sendMiniAppButton`, `sendApproveButton`) now delegate to a single `sendMiniAppPrompt({ chatId | ctx }, request, promptText, buttonText, fallbackText?)` helper.
- `resolverEngine` from/to token resolution (~75 duplicate LOC) collapsed into `resolveTokenField(slot, symbol, chainId)`.

**Flow simplifications:**

- `httpServer.handle()` routing moved from a 24-branch if/else chain to a dispatch map (`exactRoutes` lookup + small `paramRoutes` array for `:id`-style routes).
- `handleApproveMiniAppResponse` subtype branches extracted into `applySessionKeyApproval` and `applyAegisGuardApproval`.

**Intentionally deferred:** flattening `continueCompileLoop` / `handleDisambiguationReply` in `telegram/handler.ts` — higher blast-radius; revisit with explicit test coverage.

## What it is

Non-custodial, intent-based AI trading agent on Avalanche. Hexagonal Architecture (Ports & Adapters) — use-cases depend only on interfaces; assembly lives entirely in `src/adapters/inject/assistant.di.ts`. Users auth via Privy (Google OAuth or Telegram); Mini App passes `telegramChatId` to `POST /auth/privy` for automatic session linking. Agent parses natural language (including `$5` fiat shortcuts), classifies user intent, compiles a tool input schema, resolves fields (tokens, amounts, Telegram handles), and executes via ERC-4337 UserOps through ZeroDev session keys. Telegram handles resolved to EVM wallets via MTProto + Privy. Mini App receives pending auth / sign / approve requests by polling `GET /request/:requestId`.

## Tech stack

| Layer       | Choice                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| Language    | TypeScript 5.3, Node.js, strict mode                                                                     |
| Interface   | Telegram (`grammy`) + HTTP API (native `node:http`)                                                      |
| ORM         | Drizzle ORM + PostgreSQL (`pg` driver)                                                                   |
| LLM         | OpenAI (`gpt-4o` / configurable) via `openai` SDK                                                        |
| Blockchain  | `viem` ^2 — any EVM chain (configured via `CHAIN_ID`), ERC-4337                                          |
| Account Abs | ZeroDev SDK (`@zerodev/sdk`, `@zerodev/permissions`, `@zerodev/ecdsa-validator`) + `permissionless` ^0.2 |
| Validation  | Zod 4.3.6                                                                                                |
| DI          | Manual container in `src/adapters/inject/assistant.di.ts`                                                |
| Web search  | Tavily (`@tavily/core`)                                                                                  |
| Embeddings  | OpenAI embeddings + Pinecone vector index                                                                |
| Cache       | Redis via `ioredis`                                                                                      |
| Telegram    | `grammy` (bot) + `telegram` (gramjs / MTProto for @handle resolution)                                    |
| Auth        | Privy (`@privy-io/server-auth`) — no backend-issued JWTs                                                 |

## Important rules (non-negotiable)

1. **Never violate hexagonal architecture.** Use-case layer imports only from `use-cases/interface/`. Adapter layer imports from `use-cases/interface/` and its own `adapters/implementations/`. No adapter-to-adapter imports. No concrete classes in use-cases. Assembly happens exclusively in `src/adapters/inject/assistant.di.ts`. Violation = vendor lock-in.

2. **No inline string literals for configuration.** Every configurable value (API URLs, keys, model names, feature flags) must be declared as a named constant at the top of the file, or read from `process.env` (documented in `.env`). No magic strings buried inside functions or constructors. Chain-specific values are centralized in `src/helpers/chainConfig.ts` and exported as `CHAIN_CONFIG`.

3. **No raw SQL outside Drizzle migrations.** Schema changes go through `schema.ts` + `npm run db:generate && npm run db:migrate`. No ad-hoc `INSERT`/`ALTER`/`CREATE` executed against the DB.

4. **Authentication is Privy-token-only.** HTTP endpoints call `authUseCase.resolveUserId(token)` which does `verifyTokenLite` (local crypto) + DB lookup. Tokens travel as `Authorization: Bearer <privyToken>`, or `?token=` for SSE-style paths. Never issue or accept a backend JWT.

5. **Time is seconds, not ms.** Always `newCurrentUTCEpoch()`. IDs are always `newUuid()` (v4).

## Project structure

```text
src/
├── telegramCli.ts              # Combined entry (local dev) — HTTP API + Telegram bot + jobs
├── workerCli.ts                # Worker entry (PROCESS_ROLE=worker) — Telegram bot + scheduled jobs
├── httpCli.ts                  # API entry (PROCESS_ROLE=http) — HTTP only, no bot/jobs
├── migrate.ts                  # Drizzle migration runner
├── use-cases/
│   ├── implementations/        # assistant, auth, commandMapping, httpQueryTool,
│   │                           # intent, portfolio, sessionDelegation,
│   │                           # signingRequest, tokenIngestion, toolRegistration
│   └── interface/
│       ├── input/              # IAssistantUseCase, IAuthUseCase, ICommandMappingUseCase,
│       │                       # IHttpQueryToolUseCase, IIntentUseCase, IPortfolioUseCase,
│       │                       # ISessionDelegationUseCase, ISigningRequestUseCase,
│       │                       # ITokenIngestionUseCase, IToolRegistrationUseCase,
│       │                       # intent.errors.ts
│       └── output/
│           ├── blockchain/     # IChainReader, IUserOpExecutor
│           ├── cache/          # IMiniAppRequestCache, miniAppRequest.types.ts,
│           │                   # ISessionDelegationCache, ISigningRequestCache,
│           │                   # IUserProfileCache
│           ├── delegation/     # IDelegationRequestBuilder, zerodevMessage.types.ts
│           ├── repository/     # 15 repo interfaces (users, telegramSessions, conversations,
│           │                   # messages, userProfiles, tokenRegistry, intents,
│           │                   # intentExecutions, toolManifests, pendingDelegations,
│           │                   # feeRecords, commandToolMappings, httpQueryTools,
│           │                   # userPreferences, tokenDelegations)
│           ├── solver/         # ISolver, ISolverRegistry
│           ├── sse/            # (reserved)
│           ├── embedding.interface.ts
│           ├── executionEstimator.interface.ts
│           ├── intentClassifier.interface.ts
│           ├── intentParser.interface.ts       # IntentPackage, SimulationReport, INTENT_ACTION
│           ├── orchestrator.interface.ts
│           ├── privyAuth.interface.ts
│           ├── resolver.interface.ts            # IResolverEngine (field resolvers)
│           ├── schemaCompiler.interface.ts
│           ├── sqlDB.interface.ts               # DB facade aggregating all repos
│           ├── systemToolProvider.interface.ts  # ISystemToolProvider.getTools(userId, convId)
│           ├── telegramNotifier.interface.ts
│           ├── telegramResolver.interface.ts    # ITelegramHandleResolver (MTProto)
│           ├── tokenCrawler.interface.ts
│           ├── tokenRegistry.interface.ts
│           ├── tool.interface.ts                # ITool, IToolRegistry
│           ├── toolIndex.interface.ts           # IToolIndexService (Pinecone)
│           ├── toolManifest.types.ts            # ToolManifest Zod schemas
│           ├── vectorDB.interface.ts
│           ├── walletDataProvider.interface.ts  # IWalletDataProvider + DTOs (Privy-agnostic)
│           └── webSearch.interface.ts
├── adapters/
│   ├── inject/assistant.di.ts  # Wires all components; lazy singletons
│   └── implementations/
│       ├── input/
│       │   ├── http/           # HttpApiServer (httpServer.ts)
│       │   ├── jobs/           # tokenCrawlerJob.ts
│       │   └── telegram/       # bot.ts, handler.ts, handler.messages.ts,
│       │                       # handler.types.ts, handler.utils.ts
│       └── output/
│           ├── orchestrator/   # openai.ts (active)
│           ├── blockchain/     # viemClient.ts, zerodevExecutor.ts (ZerodevUserOpExecutor)
│           ├── solver/
│           │   ├── solverRegistry.ts
│           │   ├── static/claimRewards.solver.ts
│           │   └── manifestSolver/  # templateEngine.ts, stepExecutors.ts, manifestDriven.solver.ts
│           ├── intentParser/   # openai.intentParser, openai.intentClassifier,
│           │                   # openai.schemaCompiler, deterministic.executionEstimator
│           ├── resolver/       # resolverEngine.ts — per-field resolvers for RESOLVER_FIELD
│           ├── delegation/     # delegationRequestBuilder.ts (ZeroDev message builder)
│           ├── privyAuth/      # privyServer.adapter.ts
│           ├── tokenRegistry/  # db.tokenRegistry.ts
│           ├── tokenCrawler/   # pangolin.tokenCrawler.ts
│           ├── webSearch/      # TavilyWebSearchService
│           ├── tools/          # webSearch, executeIntent, getPortfolio, httpQuery
│           │   └── system/     # transferErc20, walletBalances, transactionStatus,
│           │                   # gasSpend, rpcProxy
│           ├── walletData/     # privy.walletDataProvider.ts
│           ├── embedding/      # openai.ts
│           ├── vectorDB/       # pinecone.ts
│           ├── toolIndex/      # pinecone.toolIndex.ts
│           ├── cache/          # redis.miniAppRequest, redis.sessionDelegation,
│           │                   # redis.signingRequest, redis.userProfile
│           ├── pendingCollectionStore/ # inMemory.ts + redis.ts (multi-replica pending state)
│           ├── telegram/       # bot notifier (botNotifier.ts), gramjs.telegramResolver.ts
│           ├── toolRegistry.concrete.ts          # in-memory ITool registry
│           ├── systemToolProvider.concrete.ts   # assembles system tools
│           └── sqlDB/          # DrizzleSqlDB (drizzleSqlDb.adapter.ts) + schema.ts +
│                               # 15 repositories under repositories/
└── helpers/
    ├── chainConfig.ts         # CHAIN_CONFIG — single source of truth per chain
    ├── bigint.ts              # Bigint math helpers (wei conversions, etc.)
    ├── uuid.ts                # newUuid() — v4
    ├── cache/                 # redisResponseCache.ts — generic SHA1-keyed TTL cache helper
    ├── concurrency/           # openaiLimiter.ts — p-limit singleton for all OpenAI call sites
    ├── env/                   # role.ts (PROCESS_ROLE, isWorker), yieldEnv.ts
    ├── observability/         # metricsRegistry.ts — pgPool / openai / redis / LLM metrics
    ├── enums/                 # executionStatus, intentAction (INTENT_ACTION),
    │                          # intentCommand (INTENT_COMMAND + parseIntentCommand),
    │                          # intentStatus, messageRole, resolverField (RESOLVER_FIELD),
    │                          # sessionKeyStatus, statuses (USER_STATUSES,
    │                          # CONVERSATION_STATUSES), toolCategory, toolType,
    │                          # userIntentType (USER_INTENT_TYPE), zerodevMessageType
    ├── crypto/aes.ts          # AES-256-GCM encrypt/decrypt (iv:authTag:ciphertext hex)
    ├── errors/toErrorMessage.ts
    ├── schema/addressFields.ts # Shared Zod address validators
    └── time/dateTime.ts       # newCurrentUTCEpoch() — seconds, not ms
```

## Contract Registry (Avalanche Fuji Testnet)

- **AegisToken (Proxy):** `0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69`
- **RewardController (Proxy):** `0x519092C2185E4209B43d3ea40cC34D39978073A7`

## HTTP API

Runs on `HTTP_API_PORT` (default 4000). Native Node.js HTTP — no Express. CORS allows all origins.

| Method   | Route                         | Auth   | Purpose                                                                                  |
| -------- | ----------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| `POST`   | `/auth/privy`                 | None   | Verify Privy token; upsert user + link Telegram session; returns `{ userId, expiresAtEpoch }` |
| `GET`    | `/user/profile`               | Privy  | Fetch cached user profile (SCA, session key, etc.)                                       |
| `GET`    | `/portfolio`                  | Privy  | On-chain balances for user's SCA                                                         |
| `GET`    | `/tokens?chainId=`            | None   | List verified tokens for a chain                                                         |
| `POST`   | `/tools`                      | None   | Register a dynamic tool manifest                                                         |
| `GET`    | `/tools?chainId=`             | None   | List active tool manifests                                                               |
| `DELETE` | `/tools/:toolId`              | Privy  | Deactivate a tool manifest                                                               |
| `GET`    | `/permissions?public_key=`    | None   | Fetch session-key delegation record by address                                           |
| `GET`    | `/delegation/pending`         | Privy  | Fetch latest pending delegation (ZeroDev message)                                        |
| `POST`   | `/delegation/:id/signed`      | Privy  | Mark a pending delegation as signed                                                      |
| `GET`    | `/request/:requestId`         | None   | Mini-app polls for auth/sign/approve work items                                          |
| `POST`   | `/response`                   | Privy  | Mini-app submits auth/sign/approve result (discriminated on `requestType`)               |
| `POST`   | `/command-mappings`           | None   | Register explicit `/command` → `toolId` mapping                                          |
| `GET`    | `/command-mappings`           | None   | List all command mappings                                                                |
| `DELETE` | `/command-mappings/:command`  | None   | Remove a command mapping                                                                 |
| `POST`   | `/http-tools`                 | Privy  | Register an HTTP query tool with AES-256-GCM encrypted headers                           |
| `GET`    | `/http-tools`                 | Privy  | List user's registered HTTP query tools                                                  |
| `DELETE` | `/http-tools/:id`             | Privy  | Delete an HTTP query tool                                                                |
| `GET`    | `/preference`                 | Privy  | Fetch user preference (`aegisGuardEnabled`)                                              |
| `POST`   | `/preference`                 | Privy  | Upsert user preference                                                                   |
| `GET`    | `/delegation/approval-params` | Privy  | Default token list + suggested limits for approval UI                                    |
| `POST`   | `/delegation/grant`           | Privy  | Upsert token spending delegations (`token_delegations`)                                  |
| `GET`    | `/delegation/grant`           | Privy  | List active token delegations for user                                                   |

## Telegram commands

| Command                          | Behavior                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `/start`                         | Welcome; prompts auth (Mini App link) if not logged in                                  |
| `/auth <token>`                  | Fallback Privy-token linking (Mini App users auto-linked via `POST /auth/privy`)        |
| `/logout`                        | Deletes session from DB + cache                                                         |
| `/new`                           | Clears active conversation                                                              |
| `/history`                       | Last 10 messages of current conversation                                                |
| `/confirm`                       | Execute latest `AWAITING_CONFIRMATION` intent                                           |
| `/cancel`                        | Abort pending intent                                                                    |
| `/portfolio`                     | On-chain token balances for user's SCA                                                  |
| `/wallet`                        | SCA address + session key status                                                        |
| `/sign <to> <wei> <data> <desc>` | Creates signing request; pushes to mini-app via `mini_app_req:*`                        |
| Intent slash commands            | `/money`, `/buy`, `/sell`, `/convert`, `/topup`, `/dca`, `/send` (see `INTENT_COMMAND`) |
| _(text)_                         | Chat + tool calls (web search, executeIntent, getPortfolio, system tools)               |
| _(photo)_                        | Vision chat with caption                                                                |

## Intent / message flow

```text
message:text
  ├─ token_disambig? → handleDisambiguationReply → resume resolve phase
  ├─ slash intent command → IntentCommand path → schemaCompiler
  ├─ free text → classifyIntent → toolIndex lookup → schemaCompiler
  └─ continue in-progress compile loop
                          ↓
                    schemaCompiler (fill required fields from chat)
                          ↓
                    ResolverEngine (RESOLVER_FIELD per-field resolvers:
                      fromTokenSymbol, toTokenSymbol, readableAmount, userHandle)
                          ↓
                    DeterministicExecutionEstimator (preview)
                          ↓
                    buildAndShowConfirmation
                          ↓
                    Capability creates SigningRequestRecord (via
                    ISigningRequestUseCase.create) + emits mini_app
                    artifact. Mini-app polls GET /request/:id, signs
                    with the user's own delegated session key (stored
                    in Telegram cloud), POSTs /response. Capability's
                    waitFor(requestId) resumes on resolve.
```

Key notes: auth gate runs first; fiat shortcuts (`$5`, `N usdc`) auto-inject USDC if no `fromTokenSymbol` extracted; `@handle` recipients resolved via MTProto before confirmation. Slash commands take priority over free-text classification when `parseIntentCommand(text)` matches.

## Database schema

| Table                     | Purpose                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| `users`                   | Account record (`privyDid` unique, `status`, `email`)                           |
| `telegram_sessions`       | Telegram chat ID → userId + expiry                                              |
| `conversations`           | Per-user threads (`title`, `status`)                                            |
| `messages`                | All turns (user / assistant / tool / assistant_tool_call)                       |
| `user_profiles`           | SCA address, EOA, session key, scope, status, telegramChatId                    |
| `token_registry`          | Symbol → address + decimals per chainId (unique on `(symbol, chainId)`)         |
| `intents`                 | Parsed intent records with status lifecycle                                     |
| `intent_executions`       | Per-attempt records with userOpHash + txHash + fee fields                       |
| `tool_manifests`          | Dynamic tool registry — toolId, steps (JSON), inputSchema, chainIds, priority   |
| `pending_delegations`     | Queued ZeroDev session-key delegation messages awaiting signature               |
| `fee_records`             | Protocol fee audit trail (bps split, token, addresses, txHash)                  |
| `command_tool_mappings`   | Bare word (e.g. `buy`) → `toolId` (soft FK to `tool_manifests`)                 |
| `http_query_tools`        | Developer-registered HTTP tools — name, endpoint, method                        |
| `http_query_tool_headers` | AES-256-GCM encrypted headers for HTTP tools                                    |
| `user_preferences`        | Per-user flags — `aegisGuardEnabled`                                            |
| `token_delegations`       | Aegis Guard spending limits — `limitRaw`, `spentRaw`, `validUntil` per token    |

## Redis key schema

| Key                              | Value                                   | TTL                              |
| -------------------------------- | --------------------------------------- | -------------------------------- |
| `delegation:{sessionKeyAddress}` | JSON `DelegationRecord` (session-key)   | None (lowercased address)        |
| `sign_req:{id}`                  | JSON signing request                    | `max(10s, expiresAt - now)`; `KEEPTTL` on resolve |
| `mini_app_req:{requestId}`       | JSON `MiniAppRequest` (auth/sign/approve) | 600 s                          |
| `user_profile:{userId}`          | JSON `PrivyUserProfile`                 | Per-call (min 10 s)              |
| `pending_collection:{channelId}` | JSON `PendingCollection` (capability multi-step state) | `min(pending.expiresAt - now, 1h)` |
| `tavily:{sha1(query+limit)}`     | JSON Tavily search response             | `TAVILY_CACHE_TTL_SECONDS` (300 s) |
| `relay_quote:{sha1(user+route+amount+type)}` | JSON `RelayQuote`           | `RELAY_QUOTE_CACHE_TTL_SECONDS` (15 s) |

## Environment variables

| Variable                          | Default                              | Purpose                                                |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| `DATABASE_URL`                    | `postgres://localhost/aether_intent` | PostgreSQL                                             |
| `OPENAI_API_KEY`                  | —                                    | OpenAI (LLM + embeddings)                              |
| `OPENAI_MODEL`                    | `gpt-4o`                             | LLM model                                              |
| `TELEGRAM_BOT_TOKEN`              | —                                    | Telegram bot (grammy)                                  |
| `HTTP_API_PORT`                   | `4000`                               | HTTP server port                                       |
| `TAVILY_API_KEY`                  | —                                    | Web search                                             |
| `MAX_TOOL_ROUNDS`                 | `10`                                 | Max agentic tool rounds per chat                       |
| `MINI_APP_URL`                    | —                                    | Base URL of Telegram Mini App (linked from bot prompts)|
| `CHAIN_ID`                        | `43113`                              | Resolved against `CHAIN_CONFIG` (43113 Fuji, 43114 C-Chain, 1, 8453, 137, 42161, 10) |
| `RPC_URL`                         | `CHAIN_CONFIG.defaultRpcUrls[0]`     | Primary EVM RPC endpoint override                      |
| `RPC_URL_FALLBACKS`               | `""`                                 | Comma-separated fallback RPC URLs appended to `CHAIN_CONFIG.defaultRpcUrls` |
| `AVAX_BUNDLER_URL`                | —                                    | ERC-4337 bundler endpoint (e.g. Pimlico)               |
| `BOT_PRIVATE_KEY`                 | —                                    | 32-byte hex; used by `ZerodevUserOpExecutor`           |
| `REWARD_CONTROLLER_ADDRESS`       | —                                    | `ClaimRewardsSolver` target                            |
| `PANGOLIN_TOKEN_LIST_URL`         | Pangolin GitHub raw                  | Token list source override                             |
| `TOKEN_CRAWLER_INTERVAL_MS`       | `900000`                             | Token list re-fetch interval                           |
| `REDIS_URL`                       | —                                    | Redis connection string                                |
| `DELEGATION_TTL_SECONDS`          | `604800`                             | Default session-key delegation lifetime                |
| `TG_API_ID`                       | —                                    | MTProto API ID                                         |
| `TG_API_HASH`                     | —                                    | MTProto API hash                                       |
| `TG_SESSION`                      | `""`                                 | Persisted gramjs session                               |
| `PRIVY_APP_ID`                    | —                                    | Privy app ID                                           |
| `PRIVY_APP_SECRET`                | —                                    | Privy app secret                                       |
| `PINECONE_API_KEY`                | —                                    | Pinecone (tool index)                                  |
| `PINECONE_INDEX_NAME`             | —                                    | Pinecone index name                                    |
| `PINECONE_HOST`                   | —                                    | Pinecone index host URL                                |
| `HTTP_TOOL_HEADER_ENCRYPTION_KEY` | —                                    | 32-byte hex key for AES-256-GCM                        |
| `PROCESS_ROLE`                    | `combined`                           | `worker` (bot+jobs), `http` (API only), or `combined` (dev) |
| `DB_POOL_MAX`                     | `25`                                 | Postgres pool max per replica                          |
| `DB_POOL_IDLE_TIMEOUT_MS`         | `30000`                              | Postgres pool idle timeout                             |
| `DB_POOL_CONNECTION_TIMEOUT_MS`   | `5000`                               | Postgres pool connect timeout                          |
| `MESSAGE_HISTORY_LIMIT`           | `30`                                 | Rows fetched from `messages` for assistant chat context |
| `OPENAI_CONCURRENCY`              | `6`                                  | Per-replica cap on concurrent OpenAI calls (p-limit)   |
| `PRIVY_VERIFY_CACHE_TTL_MS`       | `300000`                             | LRU TTL for Privy `verifyTokenLite` cache              |
| `PRIVY_VERIFY_CACHE_MAX`          | `5000`                               | LRU max entries for Privy verify cache                 |
| `TAVILY_CACHE_TTL_SECONDS`        | `300`                                | Redis TTL for Tavily web-search responses              |
| `RELAY_QUOTE_CACHE_TTL_SECONDS`   | `15`                                 | Redis TTL for Relay quote responses                    |
| `METRICS_TOKEN`                   | —                                    | Bearer token for `/metrics` endpoint (unset = endpoint disabled) |
| `RELAY_API_URL`                   | `https://api.relay.link`             | Relay quote API base URL                               |

## Coding conventions

- **IDs**: always `newUuid()` (UUID v4). Never `crypto.randomUUID()` or `Math.random()`.
- **Timestamps**: always `newCurrentUTCEpoch()` — seconds, never ms. Column names end in `AtEpoch` / `at_epoch`. `Date.now()` is permitted **only** for millisecond latency measurements (e.g. tool-round timing in `assistant.usecase`).
- **Config literals**: every `process.env.X` read must be hoisted to a top-of-file `const X = process.env.X ?? DEFAULT;`. No `process.env` inside a hot path.
- **Chain-specific values**: `src/helpers/chainConfig.ts` is the only place that references `CHAIN_ID` / `RPC_URL` / chain IDs / CAIP-2 strings / RPC URLs. Everything else imports `CHAIN_CONFIG` or `CAIP2_BY_PRIVY_NETWORK`. Adding a chain = one new entry in `CHAIN_REGISTRY`.
- **Enums live in `src/helpers/enums/`.** Prefer an existing enum value over an inline string. Canonical constants: `INTENT_ACTION`, `INTENT_COMMAND`, `RESOLVER_FIELD`, `USER_INTENT_TYPE`, `TOOL_TYPE`, `TOOL_CATEGORY`. `parseIntentCommand(text)` in `intentCommand.enum.ts` is the only slash-command matcher.
- **Hexagonal discipline**:
  - `use-cases/implementations/` imports only from `use-cases/interface/` and `helpers/`.
  - `adapters/implementations/` imports from `use-cases/interface/`, `helpers/`, and its own module — never from another adapter module (`input/` ↔ `output/` cross-imports are forbidden).
  - Shared wire-format types (`MiniAppRequest`, `DelegationRecord`) live under `use-cases/interface/output/cache/` so adapters on both sides can reference them without coupling.
  - Assembly happens only in `adapters/inject/assistant.di.ts`.
- **DB facade**: `assistant.di.ts` holds a single `DrizzleSqlDB`; every repo hangs off it as a property (`db.users`, `db.toolManifests`, …). Use-cases receive the concrete repo interface, never the facade.
- **Migrations**: always `npm run db:generate && npm run db:migrate`. Never raw SQL. If drizzle state is corrupted (e.g. duplicate snapshot tag), fix the meta — do not bypass with manual SQL.
- **Authentication**: Privy only. `authUseCase.resolveUserId(token)` (token from `Authorization: Bearer …` or `?token=`). No backend-issued JWTs.
- **Validation at boundaries**: every HTTP body is Zod-parsed before business logic. Use shared validators from `src/helpers/schema/` where applicable.
- **Lazy singletons**: every getter in `AssistantInject` caches (`if (!this._x) this._x = new X(...); return this._x;`). This includes services that depend on other services (e.g. `getTelegramNotifier` → `getBot`). Services that require optional env (Redis, Pinecone, Privy, bundler) return `undefined` when unconfigured — downstream code must handle that.
- **HTTP routing**: `httpServer.matchRoute` dispatches via an `exactRoutes` record (`"METHOD /path"` → handler) and a `paramRoutes` array for `:id`-style regex routes. Never add an `if (method === … && pathname === …)` branch — add an entry to one of the two tables.
- **Comments**: only where code cannot explain itself. No JSDoc, no section dividers, no restating what the code does.
- **Logging**: HTTP server tags each request with an 8-char id from `newUuid().slice(0, 8)` (`[API xxxxxxxx] →`); match that style when adding new top-level servers.
- **Encrypted secrets in DB**: AES-256-GCM via `src/helpers/crypto/aes.ts`, stored as `iv:authTag:ciphertext` hex. Used for `http_query_tool_headers`.

## Patterns

**New system tool** (free, in-memory): implement `ITool` under `output/tools/system/` → add to `SystemToolProviderConcrete.getTools()`.

**New developer HTTP tool** (DB-registered): user `POST`s `/http-tools`; loaded at runtime inside `registryFactory` in `assistant.di.ts`. Headers stored AES-256-GCM encrypted.

**New tool (other)**: add to `TOOL_TYPE` enum → implement `ITool` under `output/tools/` → register in `registryFactory`.

**New DB table**: `schema.ts` → repo interface under `use-cases/interface/output/repository/` → Drizzle impl under `output/sqlDB/repositories/` → add to `DrizzleSqlDB` → wire through `assistant.di.ts` → `npm run db:generate && npm run db:migrate`.

**New solver**: implement `ISolver` in `output/solver/static/` or generate via `manifestSolver/` → register in `getSolverRegistry()` under the correct `INTENT_ACTION`.

**New HTTP route**: add an entry to `httpServer.exactRoutes` (static path) or `httpServer.paramRoutes` (`:id`-style path). Handler signature: `(req, res, url, ...params) => Promise<void>`. Extract `userId` at the top with `await this.extractUserId(req)` for authed routes.

**New resolver field**: add to `RESOLVER_FIELD` enum → add a handler in `resolver/resolverEngine.ts` → reference it from a tool manifest's `requiredFields`.

**New intent slash command**: add to `INTENT_COMMAND` enum → `parseIntentCommand` picks it up automatically → map via `command_tool_mappings` (or `POST /command-mappings`) to a `toolId`.

**Swap wallet provider**: new file under `output/walletData/` implementing `IWalletDataProvider` → one line change in `assistant.di.ts`.

**Swap account-abstraction stack**: new file under `output/blockchain/` implementing `IUserOpExecutor` → swap `ZerodevUserOpExecutor` for it in `AssistantInject.getUserOpExecutor()`.

## 2026-04-23 — portfolio resilience fix
`PortfolioUseCaseImpl.getPortfolio` previously awaited `getNativeBalance` /
`getErc20Balance` serially inside a `for` loop; a single RPC failure on Fuji
rejected the whole promise, the HTTP handler 500'd, and the FE Portfolio tab
rendered "Could not load balance". Mirrored the resilience pattern already used
by `GetPortfolioTool` (`adapters/output/tools/getPortfolio.tool.ts`): per-token
`.catch(() => 0n)` + `Promise.all` so one bad token surfaces as zero instead of
killing the whole response. Also gets parallelism as a side benefit. Shape of
`PortfolioResult` is unchanged — no FE migration needed.

## 2026-04-23 — gas sponsorship (paymaster) for bot-triggered user ops
`ZerodevUserOpExecutor` now accepts an optional `paymasterUrl` constructor
arg. When present, it builds a `createZeroDevPaymasterClient` and wires
`{ getPaymasterData, getPaymasterStubData }` into `createKernelAccountClient`
— matching the FE pattern in `fe/privy-auth/src/utils/crypto.ts:170-205`.
When absent, the executor behaves exactly as before (SCA pays its own gas),
so the change is fully backwards-compatible.

**Config plumbing**: per the chain-agnostic rule in CLAUDE.md, the URL lives
in `CHAIN_CONFIG` (`be/src/helpers/chainConfig.ts`) as `paymasterUrl`, read
from `process.env.AVAX_PAYMASTER_URL`. `AssistantInject.getUserOpExecutor()`
passes it through. New env var documented in `.env.example`.

**Why ZeroDev paymaster over Pimlico/Biconomy**: same dashboard / project ID
as the bundler already in use — no extra integration, gas policies
(per-user caps, contract allowlists) configured in ZeroDev UI, ERC-7677
compatible so viem's `paymaster: {...}` shape works without custom glue.

**Security note**: `installSessionKey` still uses `toSudoPolicy({})`
(full-access). Before enabling sponsorship in prod, tighten to `toCallPolicy`
with target/selector allowlist and set per-user gas caps in the ZeroDev
dashboard — otherwise a compromised session blob drains the paymaster
budget, not just the user's SCA.

**Convention**: new optional chain-scoped RPC-ish URLs (bundler, paymaster)
belong on `CHAIN_CONFIG` next to `rpcUrl`, not read directly from env in DI
factories. `bundlerUrl` was also hoisted onto `CHAIN_CONFIG` for symmetry,
though `getUserOpExecutor` still reads `AVAX_BUNDLER_URL` directly for its
required-field check — that's fine; the `CHAIN_CONFIG` entry is there for
future consumers.


## 2026-04-24 — Fix first-time mobile login 401

**What**: `POST /response` with `requestType=auth` was gated by a
`resolveUserId` check that returns null when no user row exists for the
Privy DID yet — blocking the very flow that creates the user
(`loginWithPrivy`). Desktop worked only because a user row already existed
from a prior login; first-time mobile logins hit 401. Re-ordered
`handlePostResponse` so auth requests call `loginWithPrivy` directly and
take the returned `userId`, while sign/approve keep the existing
resolveUserId+ownership gate. Also unswallowed the Privy verify error in
`AuthUseCaseImpl.resolveUserId` so future failures log a reason.

**Why**: the old flow conflated "authenticate this request" with "look up
the local user row" — but for the auth endpoint, the local row is an
*output*, not a precondition. Fixing it at the handler (not in
`resolveUserId`) keeps the semantics tight: `resolveUserId` still means
"does this token map to an existing user", which is what every other
endpoint wants.

**Convention**: endpoints that can create a user (currently only
`POST /response` with `requestType=auth`) must NOT call `resolveUserId` as
a gate. They verify the token via `loginWithPrivy` / `verifyToken` and use
the returned `userId`. Every other endpoint keeps calling `resolveUserId`
and 401s on null.


## 2026-04-25 — Cloud Run deployment + GitHub Actions CI/CD

**What**: stood up the production deployment on Google Cloud Run (project
`aegis-494004`, region `us-east1`), with auto-deploy on push to `main` via
GitHub Actions. Two services, one image, role chosen at deploy time by
`PROCESS_ROLE`.

### Topology

| Service        | Role     | Public | Scaling          | Notes                                                        |
|----------------|----------|--------|------------------|--------------------------------------------------------------|
| `aegis-http`   | `http`   | yes    | 0–3, conc=80     | `httpCli` — assistant HTTP API. Scales to zero when idle.   |
| `aegis-worker` | `worker` | no (IAM) | pinned 1, no CPU throttling | `workerCli` — Telegram (grammy) long-poll + cron jobs (`tokenCrawler`, `yieldPoolScan`, `userIdleScan`, `yieldReport`) + signing-callback HTTP. |

Single image `us-east1-docker.pkg.dev/aegis-494004/aegis/aegis-backend:<sha>`.
Both listen on `8080` (Cloud Run injects `PORT`; `entrypoint.ts` already
maps `PORT` → `HTTP_API_PORT`). Both run drizzle migrations on boot via
`entrypoint.ts → migrate.ts` before dispatching to the role CLI.

**Why pin worker to 1 instance with `--no-cpu-throttling`**: it owns
long-lived state (gramJS MTProto socket, grammy long-poll loop) and timer-
driven cron jobs that must fire while there's no incoming HTTP traffic. CPU
throttling would freeze timers between requests; multi-instance would
duplicate Telegram polling and double-fire crons.

### External storage (free tier)

- **Postgres**: Neon (`us-east-1`, pooled connection string). Free tier;
  scales to zero. No Cloud SQL — its minimum cost (~$9/mo idle) wasn't
  worth it for current traffic.
- **Redis**: Upstash (`rediss://`, TLS). Pay-per-request, free tier
  covers expected load. Memorystore minimum (~$35–50/mo) was excessive.
- **Region pinning**: Neon, Upstash, and Cloud Run all in `us-east-1` to
  keep latency low and cross-region egress at zero.

### Secrets (Secret Manager)

All sensitive env vars live in **Google Secret Manager** and are mounted
into both services via `--set-secrets KEY=KEY:latest`. Non-sensitive
config (model name, intervals, pool sizes, `CHAIN_ID`, etc.) is passed
plainly via `--set-env-vars`. Compute SA was granted
`roles/secretmanager.secretAccessor` so Cloud Run can read at runtime.

Secrets stored: `DATABASE_URL`, `REDIS_URL`, `OPENAI_API_KEY`,
`PINECONE_API_KEY`, `PINECONE_HOST`, `PINECONE_INDEX_NAME`,
`TELEGRAM_BOT_TOKEN`, `TG_API_ID`, `TG_API_HASH`, `TG_SESSION`,
`PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `TAVILY_API_KEY`,
`HTTP_TOOL_HEADER_ENCRYPTION_KEY`, `METRICS_TOKEN`, `AVAX_BUNDLER_URL`,
`AVAX_PAYMASTER_URL`, `REWARD_CONTROLLER_ADDRESS`, `MINI_APP_URL`.

`MINI_APP_URL` currently points at the dev ngrok URL — update via
`gcloud secrets versions add MINI_APP_URL --data-file=- --project=aegis-494004`
then redeploy (services pin secret to `:latest` but Cloud Run only re-reads
on revision creation).

### CI/CD — GitHub Actions + Workload Identity Federation

Repo: `rye-ndt/onchain-agent`. No JSON service-account key — auth via
**WIF** so GitHub OIDC tokens impersonate the deploy SA directly.

- WIF pool: `github-pool` (global)
- WIF provider: `github-provider`, scoped by
  `attribute.repository_owner == 'rye-ndt'`
- Deploy SA: `aegis-deployer@aegis-494004.iam.gserviceaccount.com`
  bound to `principalSet://…/attribute.repository/rye-ndt/onchain-agent`
- SA roles: `run.admin`, `artifactregistry.writer`,
  `iam.serviceAccountUser`, `secretmanager.secretAccessor`

Repo variables (set via `gh variable set`, **not** secrets — they're not
sensitive):
- `GCP_PROJECT=aegis-494004`
- `WIF_PROVIDER=projects/431902544869/locations/global/workloadIdentityPools/github-pool/providers/github-provider`
- `SERVICE_ACCOUNT=aegis-deployer@aegis-494004.iam.gserviceaccount.com`

Workflow at `.github/workflows/deploy.yml`: on push to `main`, one `build`
job pushes the image tagged with `${GITHUB_SHA}`, then a matrix `deploy`
job updates both services in parallel (env/secrets stay sticky on the
service — only the image changes).

### Dockerfile changes

The hand-curated runtime-modules copy list in the builder stage was missing
deps that broke boot in the slim runtime image:

- Added `@pinojs/redact` (pino dropped `fast-redact` for this; removed
  `fast-redact` from the list).
- Added `bufferutil`, `utf-8-validate`, `node-gyp-build` — some transitive
  caller in the bundle (`viem`/`telegram` ws stack) requires them
  unconditionally rather than via try/catch, so the "ws falls back to JS"
  comment was wishful thinking. Native binaries are already built in the
  builder stage with `python3 make g++`, so this is just a copy.

**Convention**: when bumping `pino` or any package whose runtime deps are
hand-copied in the builder stage, check `node_modules/pino/package.json`
deps and update the runtime copy list — bundling externals will hide the
breakage until container start.

### Migration fix

`drizzle/0020_flippant_living_mummy.sql` seeded `loyalty_seasons.ends_at_epoch
= 9999999999`, which overflows Postgres `int4` (max `2147483647`). On a
fresh Postgres the whole migration batch rolled back, leaving an empty
schema and the worker spamming `"relation 'token_registry' does not exist"`.
Replaced with `2147483647` (year 2038 sentinel — re-issue Season N before
then).

**Convention**: when seeding "no end" / "infinity" timestamps into an `int4`
column, use `2147483647`, not arbitrarily large numbers. Long-term, consider
migrating epoch columns to `bigint` if any season is expected to outlast 2038.

### Cost (monthly estimate)

- Worker (always-on, 1 vCPU / 512Mi, no throttling): ~$13–18
- HTTP (scales to zero, low traffic): ~$0–2
- Artifact Registry storage: <$1
- Neon, Upstash, Secret Manager: $0 (free tier)
- **Total: ~$15–20/mo** — comfortably inside the $200 GCP credit.

### Observability — quick checks

```bash
# service ready
gcloud run services describe aegis-http   --region=us-east1 --project=aegis-494004 --format='value(status.conditions[0].type,status.conditions[0].status)'
gcloud run services describe aegis-worker --region=us-east1 --project=aegis-494004 --format='value(status.conditions[0].type,status.conditions[0].status)'

# recent errors
gcloud logging read 'resource.type="cloud_run_revision" AND severity>=ERROR' \
  --project=aegis-494004 --limit=10 --freshness=30m

# tail worker
gcloud beta run services logs tail aegis-worker --region=us-east1 --project=aegis-494004
```

No `/health` endpoint exists — Cloud Run's default TCP probe on `:8080` is
sufficient. End-to-end smoke test: send any message to the Telegram bot.

### Known follow-ups

- `MINI_APP_URL` is still the ngrok URL; update before shipping the FE.
- `worker.exposedPort` is reachable at the worker's Cloud Run URL but
  IAM-protected. If Telegram or any external service ever needs to call
  the signing-callback HTTP directly, change to `--allow-unauthenticated`
  or front it via the `aegis-http` service.
- If load grows past current sizing, split crons out of the worker into
  Cloud Run **Jobs** triggered by **Cloud Scheduler** so the worker stays
  lean (just the Telegram socket + signing callbacks).
