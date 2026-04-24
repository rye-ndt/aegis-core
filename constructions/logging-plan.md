# Backend Logging Plan — pino + helper-style

> Prerequisite: none.
> Blocks: nothing — incremental migration of existing `console.*` call sites.
> Behavior change: stdout shape changes from plain text to JSON; log volume gates on `LOG_LEVEL`.

## Why

- 127 ad-hoc `console.log/warn/error` calls across `src/` (CLIs, adapters, jobs, DI). Hand-rolled prefixes (`[httpCli]`, `[Redis]`, `[AssistantInject]`). No level filtering — debug noise ships to prod.
- Cloud Run / GCP Logs cannot parse severity from plain strings → all entries surface as `INFO`. Hard to grep, impossible to alert on.
- Need 3 user-facing levels (`debug` / `info` / `error`) toggleable per environment without a redeploy of code, only env.

## Architectural decision — helper, not port/adapter

Logging lives at `src/helpers/observability/logger.ts` as a singleton factory, **not** as a port in `use-cases/interface/`. This is a deliberate departure from strict hexagonal.

**Rationale:**
- Cross-cutting concerns in this codebase are already helpers, not ports: `metricsRegistry.ts`, `chainConfig.ts`, `concurrency/openaiLimiter.ts`, `env/yieldEnv.ts`. Staying consistent with that pattern matters more than textbook purity.
- A logger port would force every use-case constructor to take an `ILogger`, pushing wiring noise into `assistant.di.ts` for zero domain benefit. The domain doesn't care *how* logs are written; logging is observability, not business logic.
- pino child loggers already give us per-scope tagging without DI.

**Do not refactor this into a port + adapter under "hexagonal cleanup."** The deviation is intentional and consistent with `MetricsRegistry`. Recorded in `be/context.md` for the cleaner agent.

## Library choice — pino

- ~1 dep, no native modules → small Docker image.
- Native levels (`trace` / `debug` / `info` / `warn` / `error` / `fatal`) — we expose only `debug` / `info` / `warn` / `error` in conventions.
- JSON output → GCP severity mapping is automatic.
- `LOG_LEVEL` env is pino's standard convention.
- `pino-pretty` (devDep only — never installed in the prod Docker image) for human-readable local dev.

Rejected: winston (heavier, transport sprawl), debug (namespace-based, not level-based), hand-rolled (reinvents level filtering, redaction, child loggers).

## Step 1 — Install + helper

Add deps:
```
pnpm add pino
pnpm add -D pino-pretty
```

Confirm `pino-pretty` is **not** copied into the prod stage of `Dockerfile` (devDeps must be pruned).

Create `src/helpers/observability/logger.ts`:

```ts
import pino, { Logger } from "pino";

const LEVEL = (process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug")).toLowerCase();
const PRETTY = process.env.LOG_PRETTY === "true";

const root: Logger = pino({
  level: LEVEL,
  base: { role: process.env.PROCESS_ROLE ?? "combined" },
  ...(PRETTY
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" } } }
    : {}),
});

export function createLogger(scope: string): Logger {
  return root.child({ scope });
}

export const logger = root;
```

Env contract:

| Var | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` (prod) / `debug` (else) | pino threshold — `debug`, `info`, `warn`, `error` |
| `LOG_PRETTY` | unset | Set `true` in local dev; never set in prod |

## Step 2 — Logging conventions (record in STATUS.md after impl)

Each module instantiates one child logger at the top:

```ts
import { createLogger } from "../../../helpers/observability/logger";
const log = createLogger("yieldOptimizer");
```

Level semantics — match exactly what the user asked for:

- **`log.debug({ choice, reason }, "msg")`** — **branch decisions.** Whenever code chooses one path among ≥2: cache hit vs miss, route picked, fallback triggered, capability matched, intent classifier output. Include the chosen path and discriminator in the structured fields.
- **`log.info({ step, id, ...ctx }, "msg")`** — **step output in long procedures.** After each meaningful step in a multi-step flow: deposit built, swap quote received, pool ranked, signing request created, job tick completed.
- **`log.warn({ reason }, "msg")`** — **recoverable degradations.** Use when retry succeeded, fallback used, capability skipped due to missing dependency. (Not asked for, but pino has it; we gain nothing by aliasing it.)
- **`log.error({ err, ...ctx }, "msg")`** — **caught service errors.** In every `catch` that swallows or rethrows. Pass `err` as a field, not in the message string — pino serializes Error correctly.

Forbidden: `console.*` in `src/` after migration except in `migrate.ts` and the very top of CLI entrypoints (before logger init is meaningful).

## Step 3 — Migrate existing call sites (incremental, by area)

127 sites. Do **not** big-bang. Order:

1. **Entrypoints** — `httpCli.ts`, `workerCli.ts`, `telegramCli.ts`, `migrate.ts`. Wrap `console.log/error` for startup banners and signal handlers. (Migrate.ts may keep `console`.)
2. **DI + infra** — `adapters/inject/assistant.di.ts` Redis listeners, capability skip warnings.
3. **Adapters with frequent error paths** — Privy, Aave, Tavily, Relay, Pinecone, OpenAI orchestrator. Map throw-then-rethrow patterns to `log.error({ err })` before rethrowing.
4. **Jobs** — `tokenCrawlerJob`, `userIdleScanJob`, `yieldPoolScanJob`, `yieldReportJob`. Each job tick = one `info` line; per-user iteration = `debug`.
5. **Use-cases** — assistant, intent, capabilityDispatcher, yieldOptimizerUseCase, signingRequest. See Step 4 for the new logs to add here.

Each migration commit should be one file or one related group. Don't rewrite messages — just lift the existing string into the message arg and lift any `[prefix]` into structured fields.

## Step 4 — New critical-flow instrumentation

Beyond migration, add structured logs at these high-value branch/step points the user called out (orchestrator, resolver, capability dispatch, intent flow):

### `use-cases/implementations/assistant.usecase.ts`
- `info` after history fetch: `{ step: "history-loaded", count, conversationId }`.
- `debug` on system-prompt reuse vs rebuild branch.
- `info` after orchestrator chat completes: `{ step: "llm-response", toolCallCount, latencyMs }`.

### `adapters/implementations/output/orchestrator/openai.ts`
- `debug` per tool-call dispatched: `{ choice: "tool", name, callId }`.
- `debug` on cache-warmup branch (prompt-prefix caching).
- `error` around the OpenAI call boundary (retry vs fail).

### `use-cases/implementations/intent.usecase.ts`
- `debug` on classifier branch: `{ choice: classifiedIntent, confidence }`.
- `info` on parsed-intent shape: `{ step: "intent-parsed", command, paramKeys }`.
- `error` on schema-compile failures.

### `adapters/implementations/output/intentParser/openai.intentClassifier.ts` and `openai.intentParser.ts`
- `debug` on cache hit vs miss for prompt cache.
- `info` after classification: `{ step: "classified", intent }`.

### `use-cases/implementations/capabilityDispatcher.usecase.ts`
- `debug` on capability resolution: `{ choice: capabilityId, reason: "matched" | "fallback" }`.
- `info` per capability invocation start/end with intentId.
- `error` on capability throw — include capability name, intentId.

### `use-cases/implementations/yieldOptimizerUseCase.ts`
- `info` per pool-scan tick: `{ step: "pool-ranked", protocolId, score, apy }`.
- `debug` on disqualification branch: `{ choice: "skip", reason: "low-liquidity" | "high-utilization" }`.
- `info` per user-idle-scan iteration: `{ step: "user-checked", userId, idleUsd, willNudge }`.
- `error` around adapter calls (`getPoolStatus`, `getUserPosition`).

### `use-cases/implementations/signingRequest.usecase.ts`
- `info` on create / waitFor resolved / waitFor timeout.
- `debug` on Redis lookup branch (hit vs miss).

### `adapters/implementations/output/cache/*` (Redis adapters)
- `debug` per cache `{ choice: "hit" | "miss", key }` — already a hot branch.

### Jobs (all 4)
- `info` at tick start + end with duration.
- `error` around the outer try.

**No PII / token leakage.** Never log raw `privyToken`, raw `initData`, full request bodies, or wallet private keys. Hash or truncate before logging. Add a redaction map in `logger.ts` if any structured field becomes a leakage risk later (pino supports `redact: [...]` natively).

## Step 5 — Docker / runtime

- `Dockerfile`: nothing changes. pino has no native deps.
- `docker-compose.yml`: set `LOG_LEVEL=debug` and `LOG_PRETTY=true` for local services.
- Cloud Run: set `LOG_LEVEL=info` for `aegis-api`, `LOG_LEVEL=info` for `aegis-worker`. Bump to `debug` temporarily when investigating.
- GCP severity: pino's level → severity is auto-mapped because output is JSON with `level` numeric. Confirm in Logs Explorer after first deploy.

## After implementing

Update `be/STATUS.md`:
- Note the helper-style decision and the rationale (so it survives cleaner passes).
- Document `LOG_LEVEL` / `LOG_PRETTY` env vars in the env table.
- Note the convention: child logger per file via `createLogger(scope)`; never `console.*` outside `migrate.ts`.

## Out of scope

- No log shipping pipeline / OpenTelemetry — relying on Cloud Run stdout → GCP Logs.
- No request-id propagation middleware. Add later if/when traces become necessary.
- No `fatal` level usage — process-exit conditions stay as-is.
