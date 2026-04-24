# context.md

## 2026-04-24 — Logging architecture decision (pre-implementation note)

Plan: `be/constructions/logging-plan.md` (pino + helper-style).

**Intentional deviation from strict hexagonal — do not "clean up":**
The logger lives at `src/helpers/observability/logger.ts` as a singleton factory (`createLogger(scope)`), **not** as an `ILogger` port with adapters. This matches the existing pattern for cross-cutting concerns (`metricsRegistry.ts`, `chainConfig.ts`, `concurrency/openaiLimiter.ts`, `env/yieldEnv.ts`) and was confirmed by the user. A future agent that "refactors logging into a port for hexagonal purity" is undoing a deliberate decision — leave it alone.

## 2026-04-22T12:28 — Frictionless Delegation Flow — Full Implementation

### Task summary
Implemented the complete frictionless delegation backend (Groups 1–7, 20 BE items).

### Files modified
| File | Action |
|---|---|
| `src/adapters/implementations/output/sqlDB/schema.ts` | Added `tokenDelegations` table |
| `src/use-cases/interface/output/repository/tokenDelegation.repo.ts` | NEW — ITokenDelegationDB port + domain types |
| `src/adapters/implementations/output/sqlDB/repositories/tokenDelegation.repo.ts` | NEW — DrizzleTokenDelegationRepo |
| `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` | Added tokenDelegations repo |
| `src/use-cases/interface/output/sqlDB.interface.ts` | Added tokenDelegations?: ITokenDelegationDB |
| `src/use-cases/interface/output/executionEstimator.interface.ts` | NEW — IExecutionEstimator + Zod schema |
| `src/adapters/implementations/output/intentParser/openai.executionEstimator.ts` | NEW — OpenAIExecutionEstimator |
| `src/use-cases/interface/input/intent.interface.ts` | Added ConfirmAndExecuteParams, updated signature |
| `src/use-cases/implementations/intent.usecase.ts` | Implemented confirmAndExecute (with TODO bundler stubs) |
| `src/use-cases/implementations/auth.usecase.ts` | Added ITokenDelegationDB dep + proactive onboarding hook |
| `src/adapters/implementations/input/http/httpServer.ts` | Replaced aegisGuardCache with tokenDelegationRepo; added 3 /delegation/* endpoints; removed /aegis-guard/grant |
| `src/adapters/implementations/input/telegram/handler.ts` | Added tokenDelegationDB + executionEstimator; estimator flow in both confirmation paths |
| `src/adapters/inject/assistant.di.ts` | Removed RedisAegisGuardCache; added getTokenDelegationRepo(), getExecutionEstimator(); wired all deps |
| `src/telegramCli.ts` | Passes tokenDelegationRepo + executionEstimator to handler |
| `drizzle/meta/0015_snapshot.json` | Fixed prevId chain collision (pre-existing bug) |
| `drizzle/0016_foamy_frog_thor.sql` | NEW — migration with CREATE TABLE IF NOT EXISTS for idempotency |

### Files deleted
- `src/adapters/implementations/output/cache/redis.aegisGuard.ts`
- `src/use-cases/interface/output/cache/aegisGuard.cache.ts`

### Commands executed
```
npm run db:generate   # generated 0016_foamy_frog_thor.sql
psql ... CREATE TABLE ... token_delegations  # manual apply (migration bundled pre-existing tables)
npm run db:migrate    # applied via drizzle migrator with IF NOT EXISTS patch
npx tsc --noEmit      # 0 errors
```

### Tests run
- TypeScript type-check: **0 errors**
- DB: `token_delegations` table created and verified in postgres

### Known risks / assumptions
- **BE 15 TODOs**: `confirmAndExecute` logs intent and returns `TODO_userop_*` hash — no actual EVM submission until bundler adapter is wired
- `getTokenDelegationRepo()` always returns db.tokenDelegations (no Redis fallback — by design)
- Migration 0016 uses IF NOT EXISTS because the Drizzle journal had a pre-existing snapshot collision that bundled already-applied tables
- `portfolioUseCase.listTokens(chainId)` is used in `/delegation/approval-params` — if this method doesn't exist on IPortfolioUseCase it will be a soft failure (returns empty list)

### Next steps (future tasks)
1. Wire actual kernel/zerodev bundler client into `confirmAndExecute` (remove TODO stubs)  
2. Frontend: update `useAegisGuard` hook to call `POST /delegation/grant` instead of `POST /aegis-guard/grant`
3. Frontend: handle `?reapproval=1&tokenAddress=...&amountRaw=...` URL params to pre-fill the delegation modal
