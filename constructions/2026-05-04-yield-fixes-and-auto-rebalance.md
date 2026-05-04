# Yield — Bug Fixes + Minimal Auto-Rebalance

> Authored: 2026-05-04
> Status: Awaiting implementation
> Scope: Fix the 7 bugs identified in the 2026-05-04 yield audit, then ship the smallest possible auto-rebalance path.
> Owner of context: read this alongside `be/STATUS.md` (yield section), `be/src/adapters/implementations/output/capabilities/status.md`, and the original `be/constructions/yield-optimization-plan.md` (note: that doc is partially stale — see §0.2).

---

## 0. What this builds

### 0.1 Bug fixes (Part A)

Seven correctness/observability fixes against the existing yield feature. None change the public surface; all are internal.

### 0.2 Minimal auto-rebalance (Part B)

When the pool ranker's winner for `(chainId, token)` differs from the protocol a user is currently deposited in (with hysteresis), the bot nudges the user via Telegram. On consent, the bot sequences `withdrawAll(old) → supply(new)` in a single mini-app session. Cadence folded into the existing `userIdleScanJob`. **Nudge every user with a position** — no opt-in flag for v1. All thresholds env-configurable.

### 0.3 Out of scope (deferred to v2)

- Auto-exit on APY drop (no rebalance target).
- Per-user gas budget / breakeven guard.
- Audit table for rebalance events.
- Per-user opt-in flag.
- Rebalance for non-USDC stablecoins or non-Avalanche chains.
- Cross-protocol delegation re-approval (only matters with adapter #2).

### 0.4 Notes about prior plan drift

`be/constructions/yield-optimization-plan.md` §3 still describes `yield_deposits` / `yield_withdrawals` as the audit log. Those tables were dropped 2026-04-28 (`0026_stale_mandrill.sql`). This plan does **not** reintroduce them. The yield feature is now snapshot-based; subgraph supplies principal. After landing this plan, update that doc to cross-reference here.

---

## Part A — Bug Fixes

Implementation order matters: fix **A1** first so subsequent fixes log cleanly; **A3** before **A2** since the ranker reads APY history that A3's correction may invalidate.

### A1. Boot-time gate for `THEGRAPH_API_KEY` (audit #1)

**Problem:** When `THEGRAPH_API_KEY` is unset, `subgraphPrincipalProvider` silently returns `null` for all calls. `yieldOptimizerUseCase` then falls back to `pos.balanceRaw` as principal → lifetime PnL renders as ~0 with no warning.

**Fix:**

1. In `assistant.di.ts::getSubgraphPrincipalProvider()`, on first construction:
   - If `process.env.THEGRAPH_API_KEY` is empty/unset → `log.warn({ feature: "yield" }, "THEGRAPH_API_KEY unset — yield principal will fall back to current balance, lifetime PnL will read ~0")`.
   - Construct provider anyway (do not crash boot — yield is non-critical for stock/swap users).
2. In `subgraphPrincipalProvider.getPrincipalRaw()`, when the upstream call fails with auth-shaped errors (HTTP 401/403 or graph "missing API key"), log at `warn` once per process (gate via in-module boolean) with `{ status, url: "<host only>" }`. Subsequent failures stay at `debug` to avoid log spam.
3. In `/health` response, add `services.subgraph: "ok" | "degraded" | "disabled"` so deployment dashboards can spot it. `disabled` when key absent; `degraded` when latest call failed.

**Files:** `assistant.di.ts`, `subgraphPrincipalProvider.ts`, `httpServer.ts` (health route).
**Effort:** 0.25d.

### A2. Real EMA in `yieldPoolRanker` (audit #2)

**Problem:** `yieldPoolRanker.computeScore()` averages the history array but labels the result `EMA_7d`. With one protocol it's harmless; the moment a second adapter lands, the ranker behaves nothing like the documented formula.

**Fix:**

1. Replace the arithmetic mean with a true EMA:

   ```ts
   // newest sample at index 0; ascending α weights newer samples more.
   const alpha = 2 / (history.length + 1);
   let ema = history[history.length - 1];
   for (let i = history.length - 2; i >= 0; i--) {
     ema = alpha * history[i] + (1 - alpha) * ema;
   }
   ```

2. Document the smoothing factor in a one-line comment near the constant.
3. Unit test: feed a known series (`[5, 5, 5, 5, 100]`) and assert EMA ≠ mean and is closer to the most-recent sample.

**Files:** `yieldPoolRanker.ts`, new `yieldPoolRanker.test.ts`.
**Effort:** 0.5d.

### A3. Verify (then maybe fix) `rayToApy` math (audit #3)

**Problem:** `aaveV3Adapter.rayToApy` applies `Math.pow(1 + apr/SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1` to Aave's `liquidityRate`. Suspicious — this re-compounds an already-annualized rate. May or may not be wrong.

**Fix (verify-first):**

1. Write a one-off script `scripts/verify-aave-apy.ts`:
   - Reads Avalanche USDC pool via existing `aaveV3Adapter.getPoolStatus`.
   - Logs raw `liquidityRate` (ray), our computed APY, and a no-compound APY (`rate / 1e27`).
   - Output: a single line the engineer pastes into the PR alongside a screenshot of `app.aave.com` → Avalanche → USDC supply APY.
2. **Decision gate:** if our number ≈ Aave UI → close the bug, add a comment in `aaveV3Adapter.ts` linking to the verification PR. If diverges → replace formula with whichever matches (likely simple `rate / 1e27` for APR; if Aave UI shows compounded APY, keep formula but verify the per-second basis).
3. If formula changes, **flush** `yield:apy_series:*` Redis keys in a one-off script — historical samples from the wrong formula would otherwise bias the EMA for a week.

**Files:** new `scripts/verify-aave-apy.ts`, possibly `aaveV3Adapter.ts`, possibly `scripts/flush-yield-apy-history.ts`.
**Effort:** 1d (most of it verification + writeup).

### A4. Snapshot bootstrap gap (audit #4)

**Problem:** `yieldReportJob` discovers users via `listUsersWithRecentSnapshots(30d)`. Snapshots are written by `finalizeDeposit` and `buildDailyReport` itself. Users who deposited before this code shipped, or whose `finalize` failed, never appear in the report population — circular.

**Fix:**

1. In `yieldReportJob.tick()`, change the user-discovery source from `listUsersWithRecentSnapshots` to a **union** of:
   - `userProfileRepo.listAll()` (or however active users are enumerated today — match the source `userIdleScanJob` uses).
2. For each user, call `onChainPositionDiscovery.discover(userId)`. If any position has `balanceRaw > 0` and **no snapshot exists for today**, write a bootstrap snapshot first via `yieldRepo.upsertSnapshot(...)` before computing the delta.
3. The 24h delta on the bootstrap day will be `0` (we have no yesterday baseline). That is correct — better than not reporting at all.
4. Cap concurrency at 5 with `p-limit` to avoid hammering RPC + subgraph.

**Files:** `yieldReportJob.ts`, possibly minor signature changes on `yieldOptimizerUseCase.buildDailyReport`.
**Effort:** 1d.

### A5. Off-by-one in `listSnapshots` epoch boundary (audit #5)

**Problem:** `yieldOptimizerUseCase.ts` (around L380–381 and L471–472) calls `listSnapshots(userId, yesterdayEpoch - 1)`. The repo returns rows `> bound`, so `-1` includes today's row when one already exists, breaking 24h delta math.

**Fix:**

1. Replace the single-bound query with an explicit window: add `listSnapshotsBetween(userId, fromEpochInclusive, toEpochExclusive)` to `IYieldRepository` (or a `YieldRepoSnapshotWindow` helper).
2. Both call sites pass `[startOfYesterdayUtc, startOfTodayUtc)`.
3. Unit test: insert two snapshots — one at `yesterday 23:59:59`, one at `today 00:00:01`. Window query returns only the first.

**Files:** `IYieldRepository.ts`, `yieldRepository.ts`, `yieldOptimizerUseCase.ts`, repo test.
**Effort:** 0.25d.

### A6. Withdrawal finalization symmetry (audit #6)

**Problem:** `finalizeDeposit` writes a snapshot; `finalizeWithdrawal` is a no-op (L347–358). A withdrawal isn't reflected in snapshots until the next daily report run, and if the subgraph fetch fails that day the snapshot diverges from reality.

**Fix:**

1. After successful `withdrawAll` (called from the same code path that today no-ops in `finalizeWithdrawal`):
   - Call `onChainPositionDiscovery.discover(userId)` for the affected `(chainId, protocol, token)`.
   - `upsertSnapshot` with the freshly-read `balanceRaw` (likely `0n`).
2. Wrap in try/catch; log at `warn` on failure but **do not** rethrow — the on-chain withdraw already succeeded.

**Files:** `yieldOptimizerUseCase.ts`.
**Effort:** 0.5d.

### A7. Yield jobs silently no-start (audit #7)

**Problem:** `assistant.di.ts` returns `undefined` for the three yield jobs when Redis is missing. `workerCli.ts` uses `?.start()` with no warning. If Upstash hiccups at boot, the entire yield system goes dark.

**Fix:**

1. In `assistant.di.ts`, each yield-job getter that returns `undefined` must `log.warn({ feature: "yield", reason: "redis-missing" }, "<jobName> not started")` once per process.
2. In `workerCli.ts`, after the `?.start()` block, log an info-level summary: `log.info({ jobs: { poolScan: !!yieldPoolScanJob, idleScan: !!userIdleScanJob, report: !!yieldReportJob } }, "yield jobs status")`. Mirrors the stock capability soft-fail logging at `workerCli.ts:215`.

**Files:** `assistant.di.ts`, `workerCli.ts`.
**Effort:** 0.25d.

### A8. Documentation refresh

1. `be/STATUS.md` yield section: note the bug-fix batch, link to this doc.
2. `be/src/adapters/implementations/output/capabilities/status.md`: append a "Yield bug-fix batch — 2026-05-04" entry.
3. `be/constructions/yield-optimization-plan.md`: add a top banner — "Schema section §3 is stale; see 2026-05-04 plan."

**Effort:** 0.5d.

**Part A subtotal: ~4.25 ideal days.**

---

## Part B — Minimal Auto-Rebalance

### B1. Env & config

Add to `helpers/env/yieldEnv.ts`:

```ts
export const YIELD_ENV = {
  // …existing fields…
  rebalanceCheckIntervalMs: num("YIELD_REBALANCE_CHECK_INTERVAL_MS", 24 * 60 * 60 * 1000),
  rebalanceMinDeltaBps: num("YIELD_REBALANCE_MIN_DELTA_BPS", 50),         // require new APY ≥ current + 0.5%
  rebalanceStickyScans: num("YIELD_REBALANCE_STICKY_SCANS", 3),           // winner must hold for N consecutive pool scans
  rebalanceNudgeCooldownSec: num("YIELD_REBALANCE_NUDGE_COOLDOWN_SEC", 86_400),
} as const;
```

`rebalanceCheckIntervalMs` is the **per-user** rebalance scan cadence (24h default). It is **not** the same as `userScanIntervalMs` (idle USDC scan). Two ticks happen inside the same job; we just gate each on its own last-run timestamp.

### B2. Folding into `userIdleScanJob`

No new cron. Inside `userIdleScanJob.tick()`, after the existing idle-USDC check, add a sibling step:

```ts
// pseudo
for (const userId of activeUsers) {
  await optimizer.scanIdleForUser(userId);          // existing
  await optimizer.scanRebalanceForUser(userId);     // new
}
```

Both calls are idempotent and have their own Redis cooldowns, so running them in the same loop is safe. Concurrency stays at the existing `p-limit 5`.

### B3. Ranker hysteresis: "sticky winner"

The pool scan job already writes `yield:best:{chainId}:{token}` every 2h. We need to know whether the *same* protocol has been the winner for `rebalanceStickyScans` consecutive scans before nudging — otherwise APY noise causes flapping.

**New Redis key:** `yield:winner_streak:{chainId}:{token}` → JSON `{ protocolId, count, lastTs }`. TTL: `4 * poolScanIntervalMs` (auto-resets if scans stop).

**Update path in `runPoolScan`:**

```ts
const winner = ranked[0];
const prev = await redis.get(`yield:winner_streak:${chainId}:${token}`);
if (prev?.protocolId === winner.protocolId) {
  prev.count += 1;
  prev.lastTs = now;
} else {
  await redis.set(`yield:winner_streak:${chainId}:${token}`, { protocolId: winner.protocolId, count: 1, lastTs: now });
}
```

A "sticky winner" is one with `count >= YIELD_ENV.rebalanceStickyScans`.

**Why this is enough hysteresis (and we skip min-delta-bps inside the streak):** the streak guard is the strong filter. The min-delta-bps is checked at the **per-user** moment of nudge to ensure the move is still worth it for *that user's* position size and protocol — see B4 step 3.

### B4. New use-case method `scanRebalanceForUser`

Add to `IYieldOptimizerUseCase`:

```ts
scanRebalanceForUser(userId: string): Promise<void>;
```

**Body:**

1. Per-user cooldown: `yield:rebalance_cooldown:{userId}` set → return.
2. Per-user pending lock: `yield:rebalance_pending:{userId}` set → return (consent outstanding or rebalance in flight).
3. For each enabled `(chainId, token)`:
   a. Read sticky winner from Redis (`yield:winner_streak:...`); skip if `count < rebalanceStickyScans`.
   b. Discover user's current position via `onChainPositionDiscovery` (or read from today's snapshot if present, to save RPC). If user has no position OR is already in the winner protocol → skip.
   c. Read both current and winner APYs from `yield:best:...` cache + the streak record. If `(winnerApy - currentApy) * 10_000 < rebalanceMinDeltaBps` → skip.
4. Emit `MessageArtifact` with inline keyboard:
   - `rebalance:y:{chainId}:{token}:{fromProtocol}:{toProtocol}` → "Yes, move it"
   - `rebalance:n:{chainId}:{token}` → "Skip for now"
5. Set `yield:rebalance_pending:{userId}` (TTL 1h — auto-clears if user ignores).
6. Set `yield:rebalance_cooldown:{userId}` with TTL `rebalanceNudgeCooldownSec`.

### B5. New use-case method `buildRebalancePlan`

Add to `IYieldOptimizerUseCase`:

```ts
buildRebalancePlan(userId: string, params: {
  chainId: number;
  token: Address;
  fromProtocol: YIELD_PROTOCOL_ID;
  toProtocol: YIELD_PROTOCOL_ID;
}): Promise<Plan>;
```

**Body:**

1. Re-read the position (paranoid; user may have withdrawn between nudge and tap). If no position → emit a `MessageArtifact("Looks like you already withdrew — nothing to rebalance.")` and clear the pending lock.
2. Build steps:
   - `withdrawTxs = registry.get(fromProtocol, chainId).buildWithdrawAllTx({ user, token })`
   - `depositTxs = registry.get(toProtocol, chainId).buildDepositTx({ user, token, amountRaw: positionBalanceRaw })`
   - `steps = [...withdrawTxs, ...depositTxs]`
3. Spend bookkeeping: tag the **last** step (the `supply()` call) with `tokenAddress` + `amountRaw = positionBalanceRaw` per the convention in `STATUS.md` non-negotiable #∗ and `capabilities/status.md` "Delegation spend bookkeeping". The withdraw step is untagged (burns aToken; doesn't consume USDC delegation).
4. Emit a single `MiniAppArtifact` for step 1 only; chain steps 2..N via `miniAppRequestCache.store(...)` exactly like `swapCapability` does today.
5. Show a Markdown quote summary first: "Moving X USDC from Aave (4.1% APY) → NewProtocol (4.8% APY). Tap to sign." Reuse the `buildDepositQuoteSummary` style — add `buildRebalanceQuoteSummary`.

### B6. New `YieldCapability` callbacks

Add to the existing `yield:` callback prefix family — these are **`rebalance:` callbacks**, but routed through `YieldCapability` since they share infra. Either:

- (a) Add `rebalance:` to `YieldCapability.triggers.callbackPrefix` (preferred — single capability for the whole yield surface).
- (b) Or alias `yield:rebalance:y/n/...` callbacks. Pick (a).

`YieldCapability.collect()` adds:

- `rebalance:y:<chainId>:<token>:<from>:<to>` → call `buildRebalancePlan`, emit mini-app + cache subsequent steps. Clear `yield:rebalance_pending:{userId}` is left set so concurrent ticks see "in-flight"; clear it inside `finalizeRebalance` (B7).
- `rebalance:n:<chainId>:<token>` → clear `yield:rebalance_pending:{userId}`, emit "Got it — I'll check again later." The cooldown set in B4.6 already prevents re-nudging for 24h.

### B7. Rebalance finalization

When the last step (the new-protocol `supply`) resolves successfully:

1. `onChainPositionDiscovery` → write a fresh snapshot for both `(fromProtocol, balance=0)` and `(toProtocol, balance=newBalance)`.
2. Clear `yield:rebalance_pending:{userId}`.
3. Loyalty: award `yield_deposit` action (existing), since it materially is a fresh deposit from the user's perspective. **Do not** double-award for the withdraw leg.

If any step fails: log at `warn`, clear the pending lock, send a Telegram message ("Rebalance failed — funds remain in {fromProtocol}. No action needed."). The on-chain state is the source of truth — if withdraw succeeded but supply failed, the user has bare USDC on their SCA and the next idle scan will nudge them again.

### B8. New Redis keys (summary)

| Key | Value | TTL |
|---|---|---|
| `yield:winner_streak:{chainId}:{token}` | `{ protocolId, count, lastTs }` | `4 * poolScanIntervalMs` |
| `yield:rebalance_cooldown:{userId}` | `"1"` | `rebalanceNudgeCooldownSec` |
| `yield:rebalance_pending:{userId}` | `"1"` | `3600` (1h) |

Document in `STATUS.md` Redis schema table.

### B9. Tests (minimum viable)

- Unit: `winner_streak` increments on same protocol, resets on switch.
- Unit: `scanRebalanceForUser` skips when `count < sticky`, when delta < min bps, when user already in winner, when cooldown set.
- Unit: `buildRebalancePlan` returns `withdraw + supply` in correct order; last step tagged with `tokenAddress` + `amountRaw`.
- Manual mainnet smoke: simulate a "second adapter" by stubbing the registry to return a fake-better protocol whose `buildDepositTx` is just a no-op `supply` to a test contract; verify the full nudge → consent → mini-app → snapshot path. **Do not run on real funds until a real second adapter exists** — with only Aave there's nothing to rebalance to in production.

### B10. STATUS.md updates

- Add row to "Telegram commands" table: `rebalance:y/n` callbacks under `YieldCapability`.
- Add new env vars to the env table (B1).
- Add new Redis keys to the Redis table (B8).
- Add a feature-log line: `2026-05-04 — Auto-rebalance (minimal). Sticky winner via Redis streak. Per-user 24h cadence. Nudge → consent → withdraw+supply in one mini-app session. No opt-in flag (nudge everyone with a position).`

**Part B subtotal: ~2 ideal days.**

---

## Implementation order

1. A1, A7 (logging hygiene — cheap, unblock observability for the rest).
2. A5, A6 (small, independent correctness fixes).
3. A4 (snapshot bootstrap).
4. A3 (APY verification — branches into A2).
5. A2 (real EMA).
6. A8 (doc refresh for Part A).
7. B1, B3 (env + winner streak — needed before any user-facing rebalance behavior).
8. B4 (`scanRebalanceForUser` — gated by feature flag if you want to dark-launch; otherwise live once the stickiness has accumulated for `sticky_scans * 2h`).
9. B5, B6 (plan builder + capability callbacks).
10. B7 (finalization).
11. B2 (wire into `userIdleScanJob`).
12. B9 (tests).
13. B10 (doc updates).

## Estimate (recap)

| Phase | Ideal days |
|---|---|
| Part A — bug fixes | ~4.25 |
| Part B — minimal auto-rebalance | ~2 |
| **Total** | **~6.25 ideal days (~2 calendar weeks with review/QA)** |

## Risks

- **A3 verification could uncover that APY math has been wrong since launch.** If so, the displayed yields in past reports were inflated. Decide whether to communicate this to existing users or quietly fix forward.
- **Rebalance nudge volume is unbounded** — first deploy could nudge every existing user the day a second adapter launches. Mitigated by `rebalanceStickyScans=3` (delays first nudge by ~6h after a switch) and per-user 24h cooldown. Consider a global rollout flag if this becomes a concern.
- **Without a second adapter, the entire B-side is dormant in production.** That is intentional — ship the plumbing first, light it up when adapter #2 lands.
