# Backend Architecture Cleanup Plan

> Authored: 2026-05-05
> Scope: `be/src/` — eliminate post-NL-unification dead code, unify duplicate config reads, fix silent error handling, collapse single-impl ports
> Owner: TBD

This plan is the actionable follow-up to the 2026-05-05 architecture review. Each phase is independently shippable and safely revertible. After each step, run `npx tsc --noEmit` from `be/` and `pnpm test` (where touched). When a phase finishes, update `STATUS.md`.

---

## Conventions recap (must hold across all changes)

- **Hexagonal:** use-cases import only from `use-cases/interface/`. Adapter assembly stays in `adapters/inject/assistant.di.ts`.
- **Chain-specific values** live in `src/helpers/chainConfig.ts` only.
- **Env reads:** hoist into a single `helpers/env/<x>Env.ts` getter; do not re-read `process.env.X` from multiple modules.
- **Logging (per `CLAUDE.md`):**
  - never raw `console.*`
  - `const log = createLogger('ScopeName')` per module
  - pino backend signature: `log.level({ meta }, "kebab-case-message")`
  - every `try/catch` logs `log.error({ err, ... }, "context")` before responding/rethrowing
  - never log `privyToken`, `initData`, `serializedBlob`, `privyDid`, signatures, private keys
- **Migrations:** drizzle only. Never raw SQL bypass.

---

## Phase 1 — Delete dead intent-write infrastructure (HIGH)

**Background.** Per `STATUS.md` 2026-05-05, the `intents` and `intent_executions` tables are write-free. `IIntentDB` has zero callers. `IIntentExecutionDB` has exactly one read site (`transferHistory.usecase.ts:114`) that the same status entry concedes works fine returning empty. We left them in to "avoid migrations." Time to remove.

### Step 1.1 — Drop `IIntentDB` / `DrizzleIntentRepo`

Files to delete:
- `src/adapters/implementations/output/sqlDB/repositories/intent.repo.ts`
- `src/use-cases/interface/output/repository/intent.repo.ts`

Edits:
- `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts`
  - Remove imports/getter wiring at lines 10, 31, 53 (and any `intentDB` accessor on the interface).
- `src/use-cases/interface/output/sqlDB.interface.ts`
  - Remove the `intentDB` accessor (line 24-ish).
- `src/adapters/inject/assistant.di.ts`
  - Remove any reference to `intentDB` if it appears in factory wiring.

Verify: `rg "intentDB|IIntentDB|DrizzleIntentRepo" be/src` returns nothing.

### Step 1.2 — Decide fate of `IIntentExecutionDB`

Two options — pick **A** unless we expect to revive intent-execution tracking soon:

**Option A — delete entirely (recommended).**
- Delete `src/adapters/implementations/output/sqlDB/repositories/intentExecution.repo.ts` and `src/use-cases/interface/output/repository/intentExecution.repo.ts`.
- In `transferHistory.usecase.ts:108-130`, remove the enrichment branch that calls `intentExecutionDB.findByTxHashes`. Simplify the return shape so callers no longer expect enrichment fields. Audit callers — `assistant.di.ts` and any tool that reads `transferHistory` results — to confirm no UI relies on the dropped fields.
- Remove `intentExecutionDB` from `sqlDB.interface.ts` and `drizzleSqlDb.adapter.ts`.

**Option B — shrink to one method.**
- Trim `IIntentExecutionDB` interface to just `findByTxHashes(hashes: string[]): Promise<...>`.
- Delete every other method on the impl.
- Keep wiring as-is.

### Step 1.3 — Drop the `intents` + `intent_executions` tables (deferred)

- Generate a drizzle migration to `DROP TABLE intents, intent_executions`.
- **Do not run in prod until** Phase 1.1 + 1.2 are deployed and we have one full release cycle confirming no read regressions. Land the migration file in this PR; gate the actual rollout behind a checklist item in `STATUS.md`.

### Step 1.4 — Rename `IntentUseCaseImpl`

`use-cases/implementations/intent.usecase.ts:25-27` — class is now schema-compile only.

- Rename class file to `schemaCompile.usecase.ts`; rename class to `SchemaCompileService`.
- Update interface (`use-cases/interface/input/intent.interface.ts`) — rename `IIntentUseCase` → `ISchemaCompileService` if no other methods remain. If `IntentPackage` is referenced only by `solver.interface.ts` and `manifestSolver`, inline it there and delete `intentParser.interface.ts`.
- Update DI wiring in `assistant.di.ts`.
- Update consumers: `tool-selection.usecase.ts`, `assistantChatCapability.ts`, anywhere it's imported.

Acceptance: `rg "IntentUseCase|IIntentUseCase" be/src` returns nothing.

---

## Phase 2 — Remove unused / overlapping system tools (MED)

`assistant.usecase.ts:28-30` system prompt tells the LLM to use `get_portfolio`, `get_transfer_history`, `get_stock_quote/positions`, `wallet_balances`, `transaction_status`. Anything else is registered-but-unused.

### Step 2.1 — Delete `GasSpendTool` and `RpcProxyTool`

- Delete `src/adapters/implementations/output/tools/system/gasSpend.tool.ts`.
- Delete `src/adapters/implementations/output/tools/system/rpcProxy.tool.ts`.
- Remove their registration in `systemToolProvider.concrete.ts` and `assistant.di.ts`.
- `grep` confirm no other call sites.

### Step 2.2 — Decide `WalletBalancesTool` vs `GetPortfolioTool`

These overlap: portfolio is balances + valuation. Pick one to keep.

- **Recommend keeping `GetPortfolioTool`** (richer); delete `WalletBalancesTool` and update the system prompt in `assistant.usecase.ts:28-30` to drop `wallet_balances`.
- If product wants the lean variant retained, document the distinction in `STATUS.md`.

### Step 2.3 — Shrink `PrivyWalletDataProvider`

- After 2.1/2.2, audit `adapters/.../walletData/privy.walletDataProvider.ts` and remove now-unreferenced methods.
- If the provider becomes empty, delete it and its port `IWalletDataProvider`.

---

## Phase 3 — Centralize duplicated env reads (MED)

### Step 3.1 — `OPENAI_MODEL`

Three call sites with three different fallbacks:
- `adapters/.../intentParser/openai.schemaCompiler.ts:13` (`gpt-4o-mini`)
- `adapters/inject/assistant.di.ts:411` (`gpt-4o`)
- `helpers/env/resultCardEnv.ts:24` (other)

Action:
- Create `src/helpers/env/openaiEnv.ts` exporting `OPENAI_MODEL` (single canonical default — confirm with team which model is correct; default to `gpt-4o`) plus `OPENAI_API_KEY` if not already centralized.
- Replace all three reads with the import.
- `rg "process\.env\.OPENAI_MODEL" be/src` should return only `openaiEnv.ts`.

### Step 3.2 — `MAX_TOOL_ROUNDS`

Read in `sendCapability.ts:51`, `swapCapability.ts:50`, `assistant.usecase.ts:33`.

- Add to `helpers/env/assistantEnv.ts` (create if absent) with a single default.
- Replace all reads.

### Step 3.3 — `MINI_APP_URL`

Read in `adapters/.../input/telegram/handler.ts:14` and `adapters/.../output/artifactRenderer/telegram.ts:19`.

- Add to `helpers/env/telegramEnv.ts`.
- Replace both reads.

Acceptance: a `rg "process\.env\." be/src` audit shows every env read lives in `helpers/env/`.

---

## Phase 4 — Fix silent error handling in HTTP server (MED)

`adapters/implementations/input/http/httpServer.ts` has multiple `} catch {}` and `sendJson(..., 500, ...)` paths that swallow errors:

- Silent JSON-parse catches: lines `235, 361, 488, 557, 785, 849, 919, 1041`.
- 500-response paths missing `log.error`: lines `488, 870, 897, 1284, 1313`.

### Step 4.1 — Verify logger scope

Top of file: confirm `const log = createLogger('HttpServer')` (or equivalent). Add if missing.

### Step 4.2 — Add structured logs

For each parse-catch:
```ts
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  log.warn({ reqId, path, err: msg }, "invalid-json-body");
  return sendJson(res, 400, { error: "invalid_json" });
}
```

For each 500 path:
```ts
log.error({ err, reqId, path }, "request-handler-failed");
return sendJson(res, 500, { error: toErrorMessage(err) });
```

Privacy check: do **not** include request body, headers, or any field that could carry `privyToken`/`initData`/`serializedBlob`. Only `reqId`, `path`, `err`.

Acceptance: `rg "} catch \{$" be/src/adapters/implementations/input/http/httpServer.ts` returns zero hits (every catch binds + logs).

---

## Phase 5 — Native-asset sentinel cleanup (MED)

Two semantically-distinct sentinels are scattered as raw literals:
- `0xEeeeeEeee...` — capability-layer pseudo-address, defined as `NATIVE_PSEUDO_ADDRESS` in `chainConfig.ts:286`.
- `0x0000…0000` — Relay/Ankr zero-address sentinel, repeated literally in `relaySwap.tool.ts:21`, `ankrBalanceProvider.ts:23`, `relayCrossChainSwapPlanner.ts:11,86`.

### Step 5.1 — Add `RELAY_NATIVE_SENTINEL` to `chainConfig.ts`

```ts
/** Zero-address sentinel used by Relay & Ankr for native assets. NOT interchangeable with NATIVE_PSEUDO_ADDRESS. */
export const RELAY_NATIVE_SENTINEL = "0x0000000000000000000000000000000000000000" as const;
```

### Step 5.2 — Replace literals

Replace each literal `"0x0000…0000"` (and any local `NATIVE_CURRENCY_SENTINEL` const) with the import. Add a 1-line comment in `chainConfig.ts` documenting the difference between the two sentinels.

---

## Phase 6 — Collapse single-impl ports & wrappers (LOW)

Apply each only if no second implementation is on the near-term roadmap.

### Step 6.1 — Inline `ToolRegistryConcrete`

`adapters/.../toolRegistry.concrete.ts` is a 20-line wrapper around `Map`, used once.

- Replace the construction in `assistant.di.ts:430` with `new Map<string, ITool>()`.
- Update consumers to use `Map` API directly (`get`, `set`, `values`).
- Delete the file and its port `IToolRegistry`.

### Step 6.2 — Collapse `IExecutionEstimator`

`use-cases/interface/output/executionEstimator.interface.ts` has one impl (`deterministic.executionEstimator.ts`) with no LLM-estimator planned.

- Move the deterministic impl into `helpers/` as a plain function `estimateExecution(input): Result`.
- Delete the port and adapter file.
- Update DI + callers.

### Step 6.3 — Audit `routeStructuredToolResult`

`assistantResultRouter.ts` exports it but apparent only caller is `assistantChatCapability.ts`.

- `rg "routeStructuredToolResult" be/src`. If single-caller, inline and delete the file.

---

## Phase 7 — Documented exceptions (no code change)

Record in `STATUS.md` so future audits don't re-flag:

- `helpers/notifyResolved.ts:8` imports `resultCard.render` — sanctioned hexagonal exception (already noted in 2026-05-05 P7).
- `migrate.ts:14,16,22` use raw `console.*` — pre-pino boot. Add a 1-line comment in `migrate.ts` explaining why.
- `helpers/env/asterEnv.ts:5` `DEFAULT_DIAMOND` — BSC on-chain address held with venue env rather than `chainConfig.ts`. Either move into `chainConfig.ts` BSC entry, or add a `STATUS.md` note matching the existing `VENUE_CHAIN_ID` exception.

---

## Rollout order & risk

| Phase | Risk | Blast radius | Ship order |
|---|---|---|---|
| 1.1 Drop `IIntentDB` | low | adapter only, no callers | 1st |
| 1.2 Drop `IIntentExecutionDB` (Option A) | med | touches `transferHistory` shape | 2nd, behind regression review |
| 1.4 Rename `IntentUseCaseImpl` | low | mechanical rename | 3rd |
| 2 System tool removal | low | LLM tool registry; verify prompt updated | 4th |
| 3 Env centralization | low | mechanical | parallel |
| 4 HTTP error logs | low | adds logs only | parallel |
| 5 Sentinels | low | constant extraction | parallel |
| 6 Port collapse | low | only if no near-term second impl | last |
| 1.3 Drop tables | high | prod schema | after one release cycle |

---

## Definition of done per phase

- [ ] All edits applied; `npx tsc --noEmit` clean from `be/`.
- [ ] `pnpm test` passes (run touched suites at minimum).
- [ ] `rg` audits called out in each step return zero unintended hits.
- [ ] `STATUS.md` updated with what + why + any new conventions.
- [ ] Manual smoke test of any user-visible flow touched (chat, transfer history, tool selection).
- [ ] No regressions surfaced; if any suspected, called out in PR description per CLAUDE.md "Quality bar".
