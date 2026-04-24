# Scaling Phase 3 — Part 3: Observability hooks

> Prerequisites: none strictly, but most valuable after Phase 2 ships.
> Behavior change: **none.** Adds logs + a small `/metrics` endpoint. Does not alter any user-visible flow.
> Purpose: once you're running multi-replica in prod, you need to see which bottleneck moves next. This part installs the minimum set of metrics to decide "add replica" vs "raise `OPENAI_CONCURRENCY`" vs "upsize Postgres" without guessing.

## What we need to measure

Four things, each tied to a bottleneck we've discussed:

| Signal | Answers | Source |
| --- | --- | --- |
| DB pool utilization | "Is `POOL_MAX` too low?" | `pg.Pool.totalCount`/`idleCount`/`waitingCount` |
| LLM latency + cache ratio | "Is prompt caching actually helping?" | Existing orchestrator logs; upgrade to structured counter |
| LLM queue depth | "Is `OPENAI_CONCURRENCY` too low?" | `p-limit` internal state |
| Redis latency + ops/sec | "Are we pushing Upstash too hard?" | `ioredis` timing wrapper |

No Prometheus/Grafana required for 200 users — a `/metrics` JSON endpoint + structured logs on Cloud Run are sufficient. If volume demands it later, the JSON shape is close enough to Prometheus text format to wrap cheaply.

## Step 3.1 — Expose a minimal `/metrics` endpoint

Edit `src/adapters/implementations/input/http/httpServer.ts` (or wherever routes are registered — grep for existing route definitions like `/portfolio`).

Add a new route `GET /metrics` returning JSON:

```ts
// Add a metrics source — injected at construction, or read from a module-level
// registry. Easiest: a single singleton `MetricsRegistry`.

server.route("GET", "/metrics", async (_req, res) => {
  const snapshot = metricsRegistry.snapshot();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(snapshot));
});
```

Guard with an env-bearer token (the mini-app should not be able to pull this):

```ts
const METRICS_TOKEN = process.env.METRICS_TOKEN;

server.route("GET", "/metrics", async (req, res) => {
  if (METRICS_TOKEN) {
    const header = req.headers["authorization"];
    if (header !== `Bearer ${METRICS_TOKEN}`) {
      res.statusCode = 401;
      res.end();
      return;
    }
  }
  const snapshot = metricsRegistry.snapshot();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(snapshot));
});
```

## Step 3.2 — `MetricsRegistry` singleton

New file `src/helpers/observability/metricsRegistry.ts`:

```ts
import { openaiLimiter } from "../concurrency/openaiLimiter";
import type { Pool } from "pg";
import type Redis from "ioredis";

interface CounterSnapshot {
  count: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
}

class RollingHistogram {
  private samples: number[] = [];
  private readonly capacity = 512;

  record(ms: number): void {
    if (this.samples.length >= this.capacity) this.samples.shift();
    this.samples.push(ms);
  }

  snapshot(): { p50: number; p95: number; count: number; total: number } {
    if (this.samples.length === 0) return { p50: 0, p95: 0, count: 0, total: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const total = sorted.reduce((a, b) => a + b, 0);
    return { p50, p95, count: sorted.length, total };
  }
}

class MetricsRegistry {
  private llmLatency = new RollingHistogram();
  private redisLatency = new RollingHistogram();
  private llmCacheHitTokens = 0;
  private llmPromptTokens = 0;
  private llmCompletionTokens = 0;

  private pgPool?: Pool;
  private redis?: Redis;

  bindPgPool(pool: Pool): void { this.pgPool = pool; }
  bindRedis(redis: Redis): void { this.redis = redis; }

  recordLlmCall(ms: number, promptTokens: number, cachedTokens: number, completionTokens: number): void {
    this.llmLatency.record(ms);
    this.llmPromptTokens += promptTokens;
    this.llmCacheHitTokens += cachedTokens;
    this.llmCompletionTokens += completionTokens;
  }

  recordRedisOp(ms: number): void {
    this.redisLatency.record(ms);
  }

  snapshot() {
    const llm = this.llmLatency.snapshot();
    const redis = this.redisLatency.snapshot();
    return {
      process: {
        role: process.env.PROCESS_ROLE ?? "combined",
        uptimeSeconds: Math.floor(process.uptime()),
        rssMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
      },
      pgPool: this.pgPool ? {
        total: this.pgPool.totalCount,
        idle: this.pgPool.idleCount,
        waiting: this.pgPool.waitingCount,
      } : null,
      openaiLimiter: {
        active: openaiLimiter.activeCount,
        pending: openaiLimiter.pendingCount,
        concurrency: openaiLimiter.concurrency,
      },
      llm: {
        p50Ms: llm.p50,
        p95Ms: llm.p95,
        callCount: llm.count,
        promptTokens: this.llmPromptTokens,
        cachedTokens: this.llmCacheHitTokens,
        cacheHitRatio: this.llmPromptTokens > 0 ? (this.llmCacheHitTokens / this.llmPromptTokens) : 0,
        completionTokens: this.llmCompletionTokens,
      },
      redis: {
        p50Ms: redis.p50,
        p95Ms: redis.p95,
        opCount: redis.count,
      },
    };
  }
}

export const metricsRegistry = new MetricsRegistry();
```

## Step 3.3 — Wire the measurements

### 3.3.1 — Bind the pg Pool

Edit `src/adapters/implementations/output/sqlDB/drizzlePostgres.db.ts`. After constructing `this.pool`, add:

```ts
import { metricsRegistry } from "../../../../helpers/observability/metricsRegistry";
...
metricsRegistry.bindPgPool(this.pool);
```

### 3.3.2 — Bind the Redis client

Edit `src/adapters/inject/assistant.di.ts` `getRedis()` (line 401). After `this._redis = new Redis(url, { lazyConnect: false });`, add:

```ts
metricsRegistry.bindRedis(this._redis);
```

### 3.3.3 — Redis per-op latency

`ioredis` supports a `commandQueue` hook, but the simplest is to wrap with a single interceptor. Add in `getRedis()` after construction:

```ts
this._redis.on("ready", () => console.log("[Redis] ready"));

// Lightweight latency wrapper. ioredis sends commands through `sendCommand`,
// but we don't need per-op attribution — a sampled wrapper on frequent
// commands is enough for trend visibility.
const originalSendCommand = this._redis.sendCommand.bind(this._redis);
this._redis.sendCommand = ((cmd: any) => {
  const start = Date.now();
  const promise = originalSendCommand(cmd);
  Promise.resolve(promise).finally(() => {
    metricsRegistry.recordRedisOp(Date.now() - start);
  });
  return promise;
}) as typeof this._redis.sendCommand;
```

If this wrapper is touchy in your ioredis version, skip it — the pool + LLM signals alone cover the 80% case. Redis metrics can be a Phase 4 refinement.

### 3.3.4 — LLM per-call measurement

Edit `src/adapters/implementations/output/orchestrator/openai.ts` near the existing `[OpenAIOrchestrator] response` log:

```ts
const startedAt = Date.now();
const response = await openaiLimiter(() =>
  this.client.chat.completions.create({ model: this.model, messages, ...toolOpts }),
);
const elapsed = Date.now() - startedAt;
const promptTokens = response.usage?.prompt_tokens ?? 0;
const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
const completionTokens = response.usage?.completion_tokens ?? 0;
metricsRegistry.recordLlmCall(elapsed, promptTokens, cachedTokens, completionTokens);
console.log(`[OpenAIOrchestrator] ms=${elapsed} promptTokens=${promptTokens} cachedTokens=${cachedTokens} completionTokens=${completionTokens}`);
```

## Step 3.4 — Env + Cloud Run flag

`.env.example`:

```
METRICS_TOKEN=change-me-local-token
```

Cloud Run deployments (update from Phase 2 Part 4):

```
--set-secrets "METRICS_TOKEN=aegis-metrics-token:latest"
```

Don't publish the `/metrics` route in any API documentation — this is operator-only.

## Step 3.5 — Light dashboard script

New file `be/scripts/watch-metrics.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
URL="${1:-http://localhost:4000/metrics}"
TOKEN="${METRICS_TOKEN:-}"
while true; do
  curl -sS -H "authorization: Bearer ${TOKEN}" "$URL" | jq '{
    uptime: .process.uptimeSeconds,
    rssMb: .process.rssMb,
    pgPool: .pgPool,
    llm: {
      p50Ms: .llm.p50Ms,
      p95Ms: .llm.p95Ms,
      cacheHitRatio: (.llm.cacheHitRatio * 100 | floor),
      calls: .llm.callCount,
    },
    openaiLimiter: .openaiLimiter,
  }'
  sleep 5
done
```

`chmod +x be/scripts/watch-metrics.sh` and run during load tests.

## Decision thresholds

Use these to decide the next action when a signal is hot:

| Signal | If you see | Action |
| --- | --- | --- |
| `pgPool.waiting > 0` sustained | Pool is saturated | Raise `DB_POOL_MAX` (recheck Phase 1 Part 1's replica-×-max budget) |
| `openaiLimiter.pending > 20` sustained | LLM is the queue | Raise `OPENAI_CONCURRENCY` (then watch OpenAI quota) |
| `llm.cacheHitRatio < 0.3` after warm-up | Prompt prefix keeps changing | Audit `assistant.usecase.ts` — something is mutating the cached prefix |
| `pgPool.total` plateaued below `max` and `p95 > 1s` | Slow query, not pool | Find the query — typically missing index |
| `redis.p95 > 50 ms` | Upstash hot / network issue | Check Upstash dashboard; consider Memorystore if sustained |

## How to verify locally

1. `docker compose up -d postgres redis`.
2. `npm run dev`.
3. `curl -H "authorization: Bearer change-me-local-token" localhost:4000/metrics | jq`. Expect non-null `pgPool`, non-null `openaiLimiter`, zero'd LLM counters (no calls yet).
4. Drive a few chat requests, re-run `/metrics`. LLM counters should increment; `cacheHitRatio` should rise above 0 after 2nd turn.
5. `bash scripts/watch-metrics.sh` in another terminal — live 5s refresh.
6. `npx tsc --noEmit` — clean.

## Rollback

Remove the route registration and the three wire-up edits. `MetricsRegistry` can remain as dead code.

## Acceptance

- `GET /metrics` returns a JSON snapshot containing the documented fields.
- `METRICS_TOKEN` gate works: no token → 401.
- Local dashboard script runs clean.
- No observable impact on chat P95 from the instrumentation itself (< 1 ms overhead per LLM/Redis call).

## Record in STATUS.md

```
- 2026-04-24 — `/metrics` operator endpoint (bearer-gated via METRICS_TOKEN)
  exposes pgPool saturation, openai p-limit queue depth, LLM p50/p95 + cache
  hit ratio, and sampled Redis latency. `MetricsRegistry` singleton in
  `helpers/observability/metricsRegistry.ts`. Use `scripts/watch-metrics.sh`
  during load tests. No metrics push target yet — aggregate by hand.
```
