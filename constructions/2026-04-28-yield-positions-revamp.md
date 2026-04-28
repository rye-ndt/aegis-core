# Implementation plan: Yield positions revamp — on-chain discovery + subgraph principal

**Status:** Planned
**Author / date:** 2026-04-28
**Scope:** Backend only (`be/src/`). FE plan lives at `fe/privy-auth/constructions/2026-04-28-yield-positions-revamp.md`. The HTTP response schema for `GET /yield/positions` is preserved — no FE-blocking change.

---

## 1. Goals

Three real defects in `yieldOptimizerUseCase.getPositions` (`be/src/use-cases/implementations/yieldOptimizerUseCase.ts:390`) and adjacent flows:

1. **Active-protocol discovery is DB-only** (`yieldRepo.listActiveProtocols`). Aave positions opened outside Aegis are invisible.
2. **Principal is bookkeeping-derived** from the `yield_deposits` / `yield_withdrawals` tables. Any drift (failed write, manual withdraw, deposit from another frontend) silently corrupts lifetime PnL forever.
3. **24h PnL silently degrades to zero** when a snapshot is missing (line 461 `prevBalance = yesterdaySnapshot ? … : balanceRaw` — no `warn` log; violates `CLAUDE.md` logging rules for degraded paths).

After this plan:

- Active positions are discovered by **probing every (protocol × stablecoin) pair** from `getYieldConfig(CHAIN_ID).protocols × stablecoins` against each adapter's `getUserPosition`.
- Principal comes from **The Graph** (Messari Aave-V3 subgraph deployment `72Cez54APnySAn6h8MswzYkwaL9KjvuuKnKArnPJ8yxb`) as the single source of truth.
- Snapshot-missing degradation is **logged at `warn`** with `step: 'snapshot-missing'`.
- DB tables that no longer have a load-bearing role are **dropped via drizzle migration** (per CLAUDE.md "all migrations run through drizzle").

**Non-goals**

- Multi-chain support — stays single-chain (`CHAIN_ID=43114`, `YIELD_ENABLED_CHAIN_IDS=43114`). Confirmed with user.
- Backfill of historical principals — confirmed not required. Cut over cleanly to subgraph.
- A short-circuit Redis cache around the probe — single protocol today, fan-out is small. Defer until protocol count > 1.

---

## 2. Architectural placement (hexagonal)

Two new output ports, kept narrow so the domain stays infra-agnostic.

```
use-cases/interface/output/yield/
  IPrincipalProvider.ts        (NEW — port: cumulative net principal per user/protocol/token)
  IYieldPositionDiscovery.ts   (NEW — port: list (protocolId, tokenAddress) pairs for a user, on-chain probe)

adapters/implementations/output/yield/
  subgraphPrincipalProvider.ts (NEW — adapter: The Graph gateway query, Messari Aave-V3 schema)
  onChainPositionDiscovery.ts  (NEW — adapter: enumerate config × call adapter.getUserPosition)
```

`YieldOptimizerUseCaseImpl` depends only on the new ports. `yieldRepo.listActiveProtocols` and `yieldRepo.getPrincipalRaw` are removed from the use case. The repo interface shrinks accordingly (§5).

The HTTP route (`/yield/positions` in `httpServer.ts`) is **unchanged**; only the use case body changes.

---

## 3. Port contracts

### 3.1 `IPrincipalProvider`

`be/src/use-cases/interface/output/yield/IPrincipalProvider.ts`

```ts
import type { Address } from "viem";
import type { YIELD_PROTOCOL_ID } from "../../../../helpers/enums/yieldProtocolId.enum";

export type PrincipalQuery = {
  userAddress: Address;
  chainId: number;
  protocolId: YIELD_PROTOCOL_ID;
  tokenAddress: Address;
};

export interface IPrincipalProvider {
  /**
   * Cumulative net principal (sum(deposits) - sum(withdrawals)) in raw token units.
   * Returns null when the provider cannot answer authoritatively (network error,
   * subgraph lag) — caller treats null as "unknown" (see use-case fallback in §4.2).
   */
  getPrincipalRaw(q: PrincipalQuery): Promise<bigint | null>;
}
```

### 3.2 `IYieldPositionDiscovery`

`be/src/use-cases/interface/output/yield/IYieldPositionDiscovery.ts`

```ts
import type { Address } from "viem";
import type { YIELD_PROTOCOL_ID } from "../../../../helpers/enums/yieldProtocolId.enum";

export type DiscoveredPosition = {
  chainId: number;
  protocolId: YIELD_PROTOCOL_ID;
  tokenAddress: Address;
  balanceRaw: bigint;     // already-fetched aToken balance — saves a duplicate read in the use case
};

export interface IYieldPositionDiscovery {
  /** Probe every configured (protocol × stablecoin) on `chainId`. Returns only non-zero positions. */
  discover(chainId: number, userAddress: Address): Promise<DiscoveredPosition[]>;
}
```

---

## 4. Adapters

### 4.1 `onChainPositionDiscovery`

`be/src/adapters/implementations/output/yield/onChainPositionDiscovery.ts`

```ts
const log = createLogger("onChainPositionDiscovery");

constructor(private deps: { protocolRegistry: IYieldProtocolRegistry }) {}

async discover(chainId, userAddress): Promise<DiscoveredPosition[]> {
  const cfg = getYieldConfig(chainId);
  if (!cfg) return [];

  const candidates = cfg.protocols.flatMap((protocolId) =>
    cfg.stablecoins.map((s) => ({ protocolId, tokenAddress: s.address }))
  );

  const probed = await Promise.all(
    candidates.map(async (c) => {
      const adapter = this.deps.protocolRegistry.get(c.protocolId, chainId);
      if (!adapter) return null;
      try {
        const pos = await adapter.getUserPosition(userAddress, c.tokenAddress);
        if (!pos || pos.balanceRaw === 0n) {
          log.debug({ choice: "miss", protocolId: c.protocolId, chainId }, "probe");
          return null;
        }
        log.debug({ choice: "hit", protocolId: c.protocolId, chainId }, "probe");
        return { chainId, protocolId: c.protocolId, tokenAddress: c.tokenAddress, balanceRaw: pos.balanceRaw };
      } catch (err) {
        log.warn({ err, protocolId: c.protocolId, chainId }, "probe-failed");
        return null;
      }
    })
  );
  return probed.filter((x): x is DiscoveredPosition => x !== null);
}
```

Logging follows the convention: scope = `onChainPositionDiscovery`, structured first, message kebab-case.

### 4.2 `subgraphPrincipalProvider`

`be/src/adapters/implementations/output/yield/subgraphPrincipalProvider.ts`

Endpoint template (provided by user):
```
https://gateway.thegraph.com/api/{API_KEY}/subgraphs/id/72Cez54APnySAn6h8MswzYkwaL9KjvuuKnKArnPJ8yxb
```

Add env var `THEGRAPH_API_KEY` to `be/.env` (and `be/src/helpers/env/*` schema if present). Document in `status.md`.

GraphQL query (Messari Aave-V3 schema — `account.positions` with cumulative deposit/withdraw counters; the schema exposes `cumulativeDepositTokenAmount` and `cumulativeWithdrawTokenAmount` per `Position`):

```graphql
query Principal($user: ID!, $market: String!) {
  account(id: $user) {
    positions(where: { market: $market, side: SUPPLIER }) {
      cumulativeDepositTokenAmount
      cumulativeWithdrawTokenAmount
    }
  }
}
```

Resolution from `chainId + protocolId + tokenAddress` → `market` ID:

- For Aave V3 the `market` id is the Aave reserve `aToken` address (lowercased) on the Messari schema. We already have `aToken` in `aaveV3Adapter` — expose it via a small registry helper `getAaveMarketId(chainId, tokenAddress) → string`. Co-locate in `helpers/chainConfig.ts` since reserve metadata is chain-specific.

Implementation skeleton:

```ts
const log = createLogger("subgraphPrincipalProvider");

async getPrincipalRaw({ userAddress, chainId, protocolId, tokenAddress }) {
  if (protocolId !== YIELD_PROTOCOL_ID.AAVE_V3) return null; // only Aave today
  const market = getAaveMarketId(chainId, tokenAddress);
  if (!market) return null;
  const t0 = Date.now();
  try {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: PRINCIPAL_QUERY,
        variables: { user: userAddress.toLowerCase(), market: market.toLowerCase() },
      }),
    });
    if (!res.ok) {
      log.warn({ status: res.status, url: this.url }, "subgraph-fetch-failed");
      return null;
    }
    const json = await res.json();
    const positions = json?.data?.account?.positions ?? [];
    let net = 0n;
    for (const p of positions) {
      net += BigInt(p.cumulativeDepositTokenAmount ?? "0");
      net -= BigInt(p.cumulativeWithdrawTokenAmount ?? "0");
    }
    if (net < 0n) net = 0n;
    log.debug({ durationMs: Date.now() - t0, market }, "subgraph-principal");
    return net;
  } catch (err) {
    log.error({ err, chainId, protocolId }, "subgraph-principal-failed");
    return null;
  }
}
```

Notes:
- The Messari Aave-V3 schema may expose amounts in raw token units already; verify with one live query during implementation. If they're decimal-normalized, convert using the stablecoin's `decimals` from `getYieldConfig`.
- No retry. The use case treats `null` as "unknown" and falls back (§4.3).

### 4.3 No DB fallback for principal

User confirmed: rely fully on the subgraph; do not retain a DB principal fallback. When `getPrincipalRaw` returns `null` (network error, subgraph lag, unknown user), the use case follows the same rule as a missing snapshot: `principalRaw = balanceRaw` (zero PnL until subgraph answers). This matches the user's clarification on Q5.

---

## 5. DB schema cleanup

User confirmed: drop tables that no longer carry weight.

### 5.1 What stays

- **`yield_position_snapshots`** — still the source for 24h PnL deltas. Keep.
- The snapshot-write call sites in `finalizeDeposit`, `getPositions`, and `buildDailyReport` keep writing snapshots (rebased to use the new principal source).

### 5.2 What goes

- **`yield_deposits`** — only feeds `getPrincipalRaw` and `listActiveProtocols`. Both replaced.
- **`yield_withdrawals`** — same. `recordWithdrawal` / `recordDeposit` stop being called.
- All repo methods that read/write those tables: `recordDeposit`, `updateDepositStatus`, `recordWithdrawal`, `updateWithdrawalStatus`, `listPositions`, `listActiveProtocols`, `getPrincipalRaw`, `listUsersWithPositions` (latter is replaced — see §5.3).

### 5.3 Daily report job (`yieldReportJob.ts:73`)

`listUsersWithPositions` was DB-derived from `yield_deposits`. Replace with a query over **`yield_position_snapshots`** (`SELECT DISTINCT user_id FROM yield_position_snapshots WHERE snapshot_at_epoch >= now-30d`). New repo method: `listUsersWithRecentSnapshots(sinceEpoch: number): Promise<string[]>`.

For brand-new users with no snapshot yet, the daily-report job will skip them on day 1 — acceptable (the `getPositions` path writes a snapshot the moment they open the FE, so day-2 onwards they appear).

### 5.4 Migration

Add drizzle migration `be/src/adapters/implementations/output/sqlDB/migrations/NNNN_drop_yield_deposit_tables.sql` (generated via `drizzle-kit`):

1. `DROP TABLE yield_withdrawals;`
2. `DROP TABLE yield_deposits;`

Update `schema.ts` — delete the `yieldDeposits` and `yieldWithdrawals` exports. Run `drizzle-kit generate` to produce the SQL. **Do not write raw SQL by hand**; CLAUDE.md mandates drizzle.

### 5.5 Repo shrinkage

`IYieldRepository` becomes:

```ts
export interface IYieldRepository {
  listSnapshots(userId, sinceEpoch): Promise<YieldPositionSnapshot[]>;
  upsertSnapshot(snapshot): Promise<void>;
  listUsersWithRecentSnapshots(sinceEpoch: number): Promise<string[]>;
}
```

`yieldRepository.ts` (Postgres impl) drops the corresponding methods and table imports.

---

## 6. Use-case rewrite — `yieldOptimizerUseCase.ts`

### 6.1 New deps

```ts
deps: {
  // … existing
  principalProvider: IPrincipalProvider;
  positionDiscovery: IYieldPositionDiscovery;
  // REMOVED: nothing related to deposits/withdrawals tables
}
```

### 6.2 `getPositions` (replaces `:390-498`)

```ts
async getPositions(userId): Promise<PositionsView> {
  const emptyTotals = { principalHuman: "0.00", currentValueHuman: "0.00", pnlHuman: "+0.00" };
  const profile = await this.deps.userProfileRepo.findByUserId(userId);
  if (!profile?.smartAccountAddress) return { positions: [], totals: emptyTotals };
  const userAddress = profile.smartAccountAddress as Address;

  const chainId = getEnabledYieldChains()[0];                 // single-chain per env
  const discovered = await this.deps.positionDiscovery.discover(chainId, userAddress);
  if (discovered.length === 0) return { positions: [], totals: emptyTotals };

  const yesterday = yesterdayUtc();
  const yesterdayEpoch = Math.floor(new Date(`${yesterday}T00:00:00Z`).getTime() / 1000);
  const snapshots = await this.deps.yieldRepo.listSnapshots(userId, yesterdayEpoch - 1);

  const cfg = getYieldConfig(chainId)!;
  const views: PositionView[] = [];
  let totalPrincipalRaw = 0n;
  let totalCurrentRaw = 0n;
  let totalsDecimals = 6;

  for (const pos of discovered) {
    const stable = cfg.stablecoins.find(s => s.address.toLowerCase() === pos.tokenAddress.toLowerCase());
    if (!stable) continue;
    totalsDecimals = stable.decimals;

    const balanceRaw = pos.balanceRaw;

    const principalFromProvider = await this.deps.principalProvider.getPrincipalRaw({
      userAddress, chainId, protocolId: pos.protocolId, tokenAddress: pos.tokenAddress,
    });
    const principalRaw = principalFromProvider ?? balanceRaw;   // unknown → zero PnL

    const ySnap = snapshots.find(s =>
      s.protocolId === pos.protocolId &&
      s.tokenAddress === pos.tokenAddress &&
      s.snapshotDateUtc === yesterday
    );
    if (!ySnap) {
      log.warn(
        { step: "snapshot-missing", userId, protocolId: pos.protocolId, chainId, tokenAddress: pos.tokenAddress },
        "falling-back-to-zero-24h-delta"
      );
    }
    const prevBalance = ySnap ? BigInt(ySnap.balanceRaw) : balanceRaw;

    const adapter = this.deps.protocolRegistry.get(pos.protocolId, chainId);
    let apy = 0;
    if (adapter) {
      try { apy = (await adapter.getPoolStatus(pos.tokenAddress)).supplyApy; }
      catch (err) { log.error({ err, protocolId: pos.protocolId }, "getPoolStatus failed"); }
    }

    totalPrincipalRaw += principalRaw;
    totalCurrentRaw += balanceRaw;

    views.push({
      protocolId: pos.protocolId,
      protocolName: PROTOCOL_DISPLAY_NAMES[pos.protocolId] ?? pos.protocolId,
      chainId,
      tokenSymbol: stable.symbol,
      principalHuman: formatUnsigned(principalRaw, stable.decimals),
      currentValueHuman: formatUnsigned(balanceRaw, stable.decimals),
      pnlHuman: formatSigned(balanceRaw - principalRaw, stable.decimals),
      pnl24hHuman: formatSigned(balanceRaw - prevBalance, stable.decimals),
      apy,
    });
  }

  return {
    positions: views,
    totals: {
      principalHuman: formatUnsigned(totalPrincipalRaw, totalsDecimals),
      currentValueHuman: formatUnsigned(totalCurrentRaw, totalsDecimals),
      pnlHuman: formatSigned(totalCurrentRaw - totalPrincipalRaw, totalsDecimals),
    },
  };
}
```

### 6.3 `finalizeDeposit` / `finalizeWithdrawal`

- `finalizeDeposit`: drop the `updateDepositStatus` and `getPrincipalRaw` calls. Keep the snapshot-write loop, but drive it from `positionDiscovery.discover(chainId, userAddress)` and pull principal from `principalProvider`. Log `step: 'finalize-deposit-snapshot-written'`.
- `finalizeWithdrawal`: becomes a no-op for bookkeeping; delete the `recordWithdrawal` loop. The on-chain probe + subgraph reflect the new state on the next read. The method can be removed entirely from `IYieldOptimizerUseCase` if no caller relies on the side effect — verify by grepping; the wallet/withdraw handler likely just needs the `txSteps` from `buildWithdrawAllPlan`.
- `buildWithdrawAllPlan`: replace `listActiveProtocols` with `positionDiscovery.discover` (uses the same source of truth as the read path; eliminates the "DB says active but on-chain is zero" skip on line 350).
- `buildDailyReport`: same swap — `listActiveProtocols` → `positionDiscovery.discover`; principal via `principalProvider`; keep snapshot upsert. Add the same `snapshot-missing` warn.

### 6.4 `buildDepositPlan`

Currently calls `recordDeposit` (line 265). Remove — there's no DB row to create anymore. The deposit tx is built and returned to the caller; on confirmation, the next `getPositions` read sees the on-chain balance and the subgraph picks up the deposit (subgraph lag of seconds-to-minutes is acceptable; PnL stays at zero in the gap, then resolves). Update the `DepositPlan` return type to drop `depositId` if no consumer needs it (verify in handler code).

---

## 7. DI wiring (`adapters/inject/assistant.di.ts`)

- Construct `subgraphPrincipalProvider` once per process (reads `THEGRAPH_API_KEY` from env via the existing env helper).
- Construct `onChainPositionDiscovery` with the existing `protocolRegistry`.
- Pass both into `YieldOptimizerUseCaseImpl`.
- Remove now-unused fields from the use-case `deps` object.

---

## 8. Logging summary (per CLAUDE.md)

| Site | Level | Metadata |
|---|---|---|
| `onChainPositionDiscovery.discover` per probe | `debug` | `{ choice: 'hit'\|'miss', protocolId, chainId }` |
| `onChainPositionDiscovery.discover` probe failure | `warn` | `{ err, protocolId, chainId }` |
| `subgraphPrincipalProvider` HTTP non-2xx | `warn` | `{ status, url }` |
| `subgraphPrincipalProvider` success | `debug` | `{ durationMs, market }` |
| `subgraphPrincipalProvider` exception | `error` | `{ err, chainId, protocolId }` |
| `getPositions` snapshot missing | `warn` | `{ step: 'snapshot-missing', userId, chainId, protocolId, tokenAddress }` |
| `finalizeDeposit` lifecycle | `info` | `{ step: 'finalize-deposit-snapshot-written', userId }` |

New metadata field name worth documenting in the relevant `status.md`: `market` (Aave reserve / aToken address used as subgraph key).

---

## 9. Sequencing

1. Add ports (§3) — pure type files, no behavior change.
2. Add `onChainPositionDiscovery` adapter (§4.1) and wire into DI alongside the existing path (no-op until use case switches).
3. Add `subgraphPrincipalProvider` adapter (§4.2). Add `THEGRAPH_API_KEY` to `.env` and env schema. Smoke-test against a known wallet via a one-off script before integrating.
4. Rewrite `getPositions` (§6.2) — first place that benefits from both ports. Verify against a known wallet that previously had drift.
5. Rewrite `finalizeDeposit`, `buildWithdrawAllPlan`, `buildDailyReport` (§6.3). Remove `buildDepositPlan` DB write (§6.4).
6. Replace `listUsersWithPositions` in `yieldReportJob` (§5.3).
7. Drizzle migration to drop `yield_deposits` + `yield_withdrawals` (§5.4). Trim `IYieldRepository` and `yieldRepository.ts` (§5.5).
8. Update `status.md` files (root yield status + capabilities `status.md`) with: subgraph dependency, `market` metadata field, "principal is subgraph-derived" convention, snapshot-missing warn convention.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Subgraph lag (deposit just confirmed, subgraph not yet indexed) | Use case falls back to `principalRaw = balanceRaw` → PnL displays as 0 until next refresh. Acceptable per user's Q5 answer. |
| Subgraph deployment de-listed / endpoint changes | `principalProvider.getPrincipalRaw` returns `null` → same fallback. Logged at `warn`. Endpoint URL is env-configurable. |
| Aave market id resolution wrong on Avalanche | Validate with one manual GraphQL query against a known position during step 3. Document the resolved `market` id in code-level comment. |
| Removing `recordDeposit` breaks an unseen consumer | Grep for all references to the removed repo methods before deletion; if a Telegram handler needed `depositId` for status replies, replace the response with the on-chain `txHash` directly. |
| Migration drops a table that still has writes mid-deploy | Sequence the deploy: step 6 (use case stops writing) ships first, step 7 (drop tables) ships in a follow-up release. |

---

## 11. Out of scope

- Multi-chain enumeration (single-chain confirmed).
- Backfill of historical principals (confirmed not needed).
- Per-protocol cache around the probe (single protocol today).
- Replacing the snapshot table with an on-chain historical-block read — only meaningful when archive RPC reliability is proven.
