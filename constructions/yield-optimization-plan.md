# Yield Optimization — Implementation Plan (Backend)

> Authored: 2026-04-24
> Status: Awaiting implementation
> Feature: Proactive agent that scans idle USDC on Avalanche and optimizes it into the best Aave v3 pool, with Telegram-driven consent and daily PnL reports.

---

## 0. What This Builds

A proactive yield optimizer for non-native crypto users. Three background jobs, one capability, one protocol adapter (Aave v3), three DB tables.

- **Pool scan job** (every 2h): ranks yield protocols per chain+token; caches winner in Redis.
- **User idle scan job** (every 24h): per user, checks stablecoin idle balance; if > threshold, nudges via Telegram with inline-keyboard (25% / 50% / 75% / custom / skip).
- **Report job** (daily at 09:00 UTC): per user with positions, sends PnL snapshot.
- **`YieldCapability`**: handles `/yield`, `/withdraw`, and `yield:*` callbacks; orchestrates delegation check → mini-app sign → deposit.
- **Aave v3 adapter**: implements the three-method protocol port (`getPoolStatus`, `buildDepositTx`, `buildWithdrawAllTx`) plus `getUserPosition` (read-only, for reports & withdraw sizing).

**MVP scope:** Avalanche mainnet (43114), USDC only, Aave v3 only, tracked positions only (no off-app sweeps), no auto-rebalance.

**Explicitly deferred** (recorded in STATUS.md "deferred" section): auto-rebalance, multi-stable, cross-chain, LLM-dispatched adapter calls.

---

## 1. Answers to Design Forks (recorded here so reviewers do not relitigate)

1. **Aave only.** First adapter; interface is narrow enough to add Benqi/Yearn later.
2. **Ranking algorithm:** `score = 0.7 * EMA_7d(supplyApy) + 0.3 * currentSupplyApy`; multiply by `0.5` if `utilization > 0.95`; disqualify if `liquidityUSD < 100_000`. With a single protocol (Aave), the ranker is trivial — it picks Aave — but the logic is in place for when a second adapter lands.
3. **Idle threshold:** `YIELD_IDLE_USDC_THRESHOLD_USD`, default `$10`.
4. **Nudge cadence:** 24h cooldown (`YIELD_NUDGE_COOLDOWN_SEC`), suppressed while a prior nudge is unanswered.
5. **Delegation:** reuse **Aegis Guard** (`token_delegations` table). No new per-protocol delegation scope.
6. **Mini-app is required to sign.** The session key lives in Telegram CloudStorage, encrypted via `privyDid`-derived material. The backend cannot decrypt. Flow: tap button → mini-app opens → auto-pulls pending `SignRequest` → signs + submits → closes. Reuses `SwapCapability`'s multi-step pattern. If delegation covers the amount: **one** sign round. If not: **two** rounds (ApproveRequest to extend delegation, then deposit).
7. **`/withdraw` scope:** withdraws tracked positions only (rows in `yield_deposits`). Off-app sweeps are out of scope.
8. **Report time:** 09:00 UTC, configurable via `YIELD_REPORT_UTC_HOUR`.
9. **Chain:** mainnet (43114). Fuji is ignored.

---

## 2. Env & Config

### 2.1 `src/helpers/env/yieldEnv.ts` (new)

```ts
export const YIELD_ENV = {
  idleUsdcThresholdUsd: num("YIELD_IDLE_USDC_THRESHOLD_USD", 10),
  poolScanIntervalMs: num("YIELD_POOL_SCAN_INTERVAL_MS", 2 * 60 * 60 * 1000),
  userScanIntervalMs: num("YIELD_USER_SCAN_INTERVAL_MS", 24 * 60 * 60 * 1000),
  reportUtcHour: num("YIELD_REPORT_UTC_HOUR", 9),
  nudgeCooldownSec: num("YIELD_NUDGE_COOLDOWN_SEC", 86_400),
  enabledChainIds: list("YIELD_ENABLED_CHAIN_IDS", [43114]),
} as const;
```

Parsed once at module load. Never re-read in hot paths.

### 2.2 `src/helpers/chainConfig.ts` (extend)

Extend `ChainEntry`:

```ts
yield?: {
  stablecoins: Array<{ symbol: string; address: Address; decimals: number }>;
  protocols: YieldProtocolId[];          // e.g. ['aave-v3']
  aave?: { poolAddress: Address; dataProviderAddress: Address };
};
```

Populate only for `43114`. All token/pool addresses live here — **never inlined elsewhere** (CLAUDE.md rule). Add helpers:

```ts
export function getYieldConfig(chainId: number): ChainEntry['yield'] | null;
export function getEnabledYieldChains(): number[];   // intersect YIELD_ENV.enabledChainIds with entries that have `yield`
```

### 2.3 `src/helpers/enums/yieldProtocolId.enum.ts` (new)

```ts
export enum YIELD_PROTOCOL_ID { AAVE_V3 = 'aave-v3' }
```

---

## 3. DB Schema (drizzle)

Add to `src/adapters/implementations/output/sqlDB/schema.ts`:

### 3.1 `yield_deposits`

Audit log — every deposit the agent submits. Source of truth for "principal invested per user per protocol."

```ts
export const yieldDeposits = pgTable("yield_deposits", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  chainId: integer("chain_id").notNull(),
  protocolId: text("protocol_id").notNull(),      // YIELD_PROTOCOL_ID
  tokenAddress: text("token_address").notNull(),
  amountRaw: text("amount_raw").notNull(),        // store as text; bigint
  requestedPct: integer("requested_pct").notNull(),
  idleAtRequestRaw: text("idle_at_request_raw").notNull(),
  txHash: text("tx_hash"),
  userOpHash: text("user_op_hash"),
  status: text("status").notNull(),               // 'pending' | 'submitted' | 'confirmed' | 'failed'
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
```

Indexed by `(userId, chainId, protocolId)`.

### 3.2 `yield_withdrawals`

Symmetric to `yield_deposits`. Stores `/withdraw` events. Simplifies PnL calc and audit.

```ts
id, userId, chainId, protocolId, tokenAddress, amountRaw (withdrawn underlying),
txHash, userOpHash, status, createdAtEpoch, updatedAtEpoch
```

### 3.3 `yield_position_snapshots`

Daily snapshot per (user, chain, protocol, token). Required to compute 24h delta in the daily report.

```ts
(userId, chainId, protocolId, tokenAddress, snapshotDateUtc) unique
→ balanceRaw (current aToken balance in underlying units), principalRaw (cumulative deposits − withdrawals), snapshotAtEpoch
```

### 3.4 Migration

Generated by `drizzle-kit generate`. Applied via existing `migrate.ts`. **No raw SQL** (CLAUDE.md rule).

---

## 4. Ports (use-cases/interface)

### 4.1 `use-cases/interface/yield/IYieldProtocolAdapter.ts`

The three-method contract plus read-only position getter. Typed args (no LLM dispatch for v1 — see §10).

```ts
export interface IYieldProtocolAdapter {
  readonly id: YIELD_PROTOCOL_ID;
  readonly chainId: number;

  // (1) Pool status — used by ranker + report.
  getPoolStatus(token: Address): Promise<{
    supplyApy: number;           // e.g. 0.0412 = 4.12%
    utilization: number;         // 0..1
    liquidityRaw: bigint;
    timestamp: number;
  }>;

  // (2) Delegate / deposit — returns unsigned tx steps.
  buildDepositTx(params: {
    user: Address;
    token: Address;
    amountRaw: bigint;
  }): Promise<TxStep[]>;         // approve (if needed) + supply

  // (3) Withdraw all.
  buildWithdrawAllTx(params: {
    user: Address;
    token: Address;
  }): Promise<TxStep[]>;

  // Read-only; needed for daily report + withdraw sizing.
  getUserPosition(user: Address, token: Address): Promise<{
    balanceRaw: bigint;          // current aToken balance in underlying
  } | null>;
}
```

### 4.2 `use-cases/interface/yield/IYieldProtocolRegistry.ts`

```ts
interface IYieldProtocolRegistry {
  get(id: YIELD_PROTOCOL_ID, chainId: number): IYieldProtocolAdapter | null;
  listForChain(chainId: number): IYieldProtocolAdapter[];
}
```

### 4.3 `use-cases/interface/yield/IYieldPoolRanker.ts`

```ts
interface IYieldPoolRanker {
  rank(statuses: Array<{ protocolId: YIELD_PROTOCOL_ID; status: PoolStatus }>,
       history: Record<YIELD_PROTOCOL_ID, number[]>): RankedPool[]; // sorted desc by score
}
```

### 4.4 `use-cases/interface/yield/IYieldRepository.ts`

Drizzle-hidden port: `recordDeposit`, `updateDepositStatus`, `recordWithdrawal`, `listPositions(userId)`, `listSnapshots(userId, since)`, `upsertSnapshot`.

### 4.5 `use-cases/interface/yield/IYieldOptimizerUseCase.ts`

Orchestration façade used by the jobs + capability.

```ts
interface IYieldOptimizerUseCase {
  runPoolScan(): Promise<void>;                                   // pool scan job
  scanIdleForUser(userId: string): Promise<ScanResult>;           // idle scan job
  buildDepositPlan(userId: string, pct: number): Promise<Plan>;   // capability
  finalizeDeposit(userId: string, depositId: string,
                  txHash: string): Promise<void>;                 // called when sign done
  buildWithdrawAllPlan(userId: string): Promise<Plan>;            // /withdraw
  buildDailyReport(userId: string): Promise<Report>;              // report job
}
```

---

## 5. Adapter Implementations

### 5.1 `adapters/implementations/output/yield/aaveV3Adapter.ts`

- `getPoolStatus`: call `PoolDataProvider.getReserveData(token)` → extract `liquidityRate` (ray) → `supplyApy = rayToApy(liquidityRate)`. `utilization = totalBorrow / (totalLiquidity)`; `liquidityRaw = totalATokenSupply - totalVariableDebt`.
- `buildDepositTx`: returns `[approve(aavePool, amount), pool.supply(token, amount, user, 0)]`. Approve is skipped if current allowance ≥ amount (read via `allowance` call).
- `buildWithdrawAllTx`: `[pool.withdraw(token, MAX_UINT256, user)]`.
- `getUserPosition`: read `aToken.balanceOf(user)` (aToken address from `PoolDataProvider.getReserveTokensAddresses`).

All addresses sourced from `chainConfig.ts` — never inlined.

### 5.2 `adapters/implementations/output/yield/yieldProtocolRegistry.ts`

Same shape as `SolverRegistry`. Constructed in DI from the list of enabled protocols per chain.

### 5.3 `adapters/implementations/output/yield/yieldRepository.ts`

Drizzle implementation of `IYieldRepository`.

---

## 6. Use-Case Implementation

### 6.1 `yieldPoolRanker.ts`

Pure function. Uses APY history from Redis (see §8). Formula per §1.2.

### 6.2 `yieldOptimizerUseCase.ts`

All orchestration. Key flows:

**`runPoolScan()`:**
1. For each enabled chain, for each configured `stablecoin × protocol`, call `getPoolStatus`.
2. Push APY sample into Redis list `yield:apy_series:{chainId}:{protocolId}:{token}` (trim to 168 samples = 7 days @ 1h — but scan runs every 2h, so trim to 84).
3. Rank; write winner to `yield:best:{chainId}:{token}` (TTL 3h).

**`scanIdleForUser(userId)`:**
1. Load user (smartAccountAddress) + profile from DB.
2. Check Redis cooldown `yield:nudge_cooldown:{userId}`; if set, skip.
3. Read USDC balance on smart account (RPC via existing read client).
4. If `balance < threshold` → skip.
5. Read cached winner from Redis. If missing → skip (scan job will populate).
6. Emit a `MessageArtifact` via `TelegramArtifactRenderer` (callback buttons `yield:opt:25|50|75|custom|skip`).
7. Set cooldown TTL.

**`buildDepositPlan(userId, pct)`:**
1. Load user, current USDC balance, winner protocol.
2. `depositAmount = floor(balance * pct / 100)`.
3. Read Aegis Guard `token_delegations` for USDC.
4. Branch:
   - **Within delegation** → insert `yield_deposits` row (status `pending`), create single `SignRequest` carrying `TxStep[]` from `buildDepositTx`. Return `MiniAppArtifact(SignRequest)`.
   - **Exceeds** → create `ApproveRequest` (subtype `aegis_guard`) with new limit `max(currentLimit, depositAmount)`. On approval, continue into the sign round.

**`finalizeDeposit(userId, depositId, txHash)`:**
- Wait for receipt via existing `transactionStatus` pathway; update `yield_deposits` → `confirmed` or `failed`; upsert today's `yield_position_snapshots` row.

**`buildWithdrawAllPlan(userId)`:**
1. For each protocol in `listPositions(userId)` where `balanceRaw > 0`: accumulate `buildWithdrawAllTx`.
2. Return a single `SignRequest` (multi-step) — reuses `SwapCapability`'s multi-step sign pattern.
3. On success: insert one `yield_withdrawals` row per protocol; zero out snapshots.

**`buildDailyReport(userId)`:**
- For each position, current `balanceRaw` − yesterday's snapshot = 24h delta; sum over protocols. Include principal (from `yield_deposits − yield_withdrawals`) and lifetime PnL.

---

## 7. Jobs

All three follow the `TokenCrawlerJob` pattern: class with `.start()` / `.stop()`, `setInterval`, `.catch(log)`.

### 7.1 `yieldPoolScanJob.ts`
- Interval: `YIELD_ENV.poolScanIntervalMs`.
- Body: `optimizer.runPoolScan()`.

### 7.2 `userIdleScanJob.ts`
- Interval: `YIELD_ENV.userScanIntervalMs`.
- Body: list active users (join `telegram_sessions` non-expired) → per user `optimizer.scanIdleForUser(userId)` (sequential with small concurrency, e.g. `p-limit` 5).

### 7.3 `yieldReportJob.ts`
- Interval: `5 * 60 * 1000` (tick every 5 min).
- Body: if current UTC hour == `YIELD_ENV.reportUtcHour` and Redis flag `yield:report_done:{YYYY-MM-DD}` unset → iterate users with positions → build + send report → set flag (TTL 25h).

All three wired in `adapters/inject/assistant.di.ts` and started from the existing app bootstrap. DI additions:

- `yieldRepository`
- `aaveV3Adapter` (per enabled chain)
- `yieldProtocolRegistry`
- `yieldPoolRanker`
- `yieldOptimizerUseCase`
- `yieldPoolScanJob`, `userIdleScanJob`, `yieldReportJob`

---

## 8. Redis Keys

| Key | Value | TTL |
|---|---|---|
| `yield:best:{chainId}:{token}` | `{protocolId, score, apy, ts}` | 3h |
| `yield:apy_series:{chainId}:{protocolId}:{token}` | list of `{apy, ts}` (cap 84) | none |
| `yield:nudge_cooldown:{userId}` | `1` | `YIELD_NUDGE_COOLDOWN_SEC` |
| `yield:nudge_pending:{userId}` | `1` (set on nudge, cleared on skip/deposit) | 48h |
| `yield:report_done:{YYYY-MM-DD}` | `1` | 25h |

---

## 9. Telegram Capability

### 9.1 `yieldCapability.ts`

- Commands: `/yield` (manual trigger — same flow as auto-nudge), `/withdraw` (triggers `buildWithdrawAllPlan`).
- Callback prefix: `yield:`.
- Artifact-based (no direct `bot.api.sendMessage`), consistent with the capability contract.

### 9.2 `YieldCapability.collect()`

1. If callback `yield:opt:<pct>`: parse pct (or route to `yield:custom` → prompt text input).
2. If callback `yield:skip`: clear `yield:nudge_pending`, emit message "No problem — I'll check again tomorrow."
3. If `pct` known → `optimizer.buildDepositPlan(userId, pct)` → emit `MiniAppArtifact`.
4. For `/withdraw` → `optimizer.buildWithdrawAllPlan(userId)` → emit `MiniAppArtifact`.

### 9.3 Signing protocol

- Within delegation: one `SignRequest` kind: `'yield_deposit'` or `'yield_withdraw'`.
- Over delegation: emit `ApproveRequest` first; FE's existing `ApprovalOnboarding` handles it; on backend-side completion, capability re-runs and emits the sign step.

### 9.4 Assistant integration

Register `INTENT_ACTION.DEPOSIT_YIELD` and a solver stub that dispatches free-text intents ("optimize my idle USDC") to `YieldCapability`. Low priority — the nudge-driven path is the main UX.

---

## 10. Why No LLM-Dispatched Adapter Calls in v1

The user's original plan proposed: "adapter has method signatures → LLM extracts args from user intent → calls method." Deferred because:

- The capability already has all data typed: `userId` (session), `amount` (balance × pct), `token` (chain config), `protocolId` (Redis winner). Nothing to extract.
- With one protocol, LLM dispatch adds cost + latency + failure surface with no upside.
- The adapter interface is narrow and stable; an LLM dispatcher can be added later as a thin wrapper in `use-cases` (reusing the existing manifest-solver engine) when protocol count justifies it.

**Recorded in STATUS.md as deferred.**

---

## 11. STATUS.md Updates

Add a "Yield Optimization" section covering:

- What the feature does and which files own which piece.
- **Deferred work (must implement before v2):**
  - Auto-rebalance when a better pool appears (and auto-exit on APY drop > threshold). Without this, "optimization" degrades over time.
  - Partial withdrawal (`/withdraw <pct>` or `/withdraw <amount>`).
  - Multi-stablecoin support (schema ready; adapter ready; enable per chain config).
  - Additional protocol adapters (Benqi, Yearn).
  - LLM-based adapter dispatch.
  - Per-user timezone for reports.
- New conventions introduced:
  - `yield:` Redis namespace.
  - `YIELD_PROTOCOL_ID` enum is source of truth; never inline string IDs.
  - All protocol addresses live in `chainConfig.ts > yield` — never inlined elsewhere.
  - Audit log via `yield_deposits` + `yield_withdrawals` is the principal source of truth; snapshots are derived.

---

## 12. Testing

- **Unit:** `yieldPoolRanker` (formula, disqualify rules), `aaveV3Adapter` (mock RPC: tx encoding correct, APY math correct).
- **Integration:** drizzle repo round-trip; `yieldOptimizerUseCase` with in-memory registry + fake adapter covering the four flows (nudge, deposit-within-delegation, deposit-over-delegation, withdraw-all).
- **Job smoke:** boot app against Fuji with a mock adapter; assert no crashes over 3 scan cycles.
- **Manual E2E on mainnet:** single real user with small USDC → nudge → deposit 10% → check Aave position → `/withdraw` → check balance restored.

---

## 13. Implementation Order

1. Schema + migration (§3).
2. `chainConfig.ts` extension + env module (§2).
3. Ports (§4).
4. Aave adapter + registry + repository (§5).
5. Ranker + optimizer use-case (§6).
6. Pool scan job (§7.1) — verify Redis winner populates.
7. `YieldCapability` skeleton: `/yield` manual entry (§9.1–9.3).
8. Idle scan job (§7.2).
9. Report job (§7.3) + snapshots.
10. `/withdraw` (§6, §9).
11. Tests (§12).
12. STATUS.md (§11).
