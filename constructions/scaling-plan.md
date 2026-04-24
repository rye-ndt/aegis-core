# Backend Scaling Plan — 10 → 200 concurrent users

> Authored: 2026-04-24
> Scope: `be/src/` + deployment. Stateless the API surface, cap external-service fan-out, and tune the data plane so the process can horizontally scale on Cloud Run.
> **Non-goal: no behavior change.** Every step preserves user-facing semantics. Anything that changes behavior is explicitly called out and deferred.

## Why we're capped at ~10 today

Four stacked bottlenecks (full audit in conversation log; summary here):

1. **Single Node process** — `Dockerfile` launches one `node dist/telegramCli.js`. One event loop; JSON/Zod parsing on LLM responses is CPU-bound and serializes at ~8–10 concurrent requests.
2. **Postgres pool default = 10** — `src/adapters/implementations/output/sqlDB/drizzlePostgres.db.ts:20` constructs `new Pool()` with no `max`. Node `pg` defaults to 10. With ~5 queries per request × 10 users, the pool is starved.
3. **No LLM concurrency cap** — `src/adapters/implementations/output/orchestrator/openai.ts:68` calls `chat.completions.create` with no queue/semaphore. 10 parallel users → 10 parallel LLM calls → tier rate-limit cascades.
4. **In-process multi-step state** — `src/adapters/implementations/output/pendingCollectionStore/inMemory.ts:8` (`new Map`) and `src/adapters/implementations/input/telegram/handler.ts:19` (`sessionCache`). Any multi-step flow (`/send Alice 10` → "Alice Evenson?" → "yes") pins a user to one process. Blocks horizontal scale outright.

Conversation history is already in Postgres (`messages` table) — **not** the bottleneck, despite being the obvious suspect. Do not move it to Redis.

## Target

| Metric | Today | Target |
| --- | --- | --- |
| Concurrent users (sustained) | ~10 | 200 |
| P95 chat round-trip | unmeasured | < 6 s |
| P95 portfolio query | unmeasured | < 1.5 s |
| Cloud Run replicas | 1 | 2–8 (autoscale) |
| DB pool per replica | 10 | 25 |
| Redis | present but underused | primary shared-state store |

## Dependency graph

Parts are ordered by prerequisite. Never run a Phase 2 part before all of Phase 1 is merged.

```
Phase 1 (no infra change, pure code tuning)
  part1  DB pool + message query LIMIT
  part2  LLM concurrency cap + prompt caching
  part3  Privy token LRU cache

Phase 2 (shared state + horizontal scale)
  part1  Redis pending collection store adapter           ← unlocks multi-replica
  part2  Redis Telegram session cache adapter             ← unlocks multi-replica
  part3  Worker process split (jobs out of the API)       ← must ship with part4
  part4  Cloud Run multi-replica deploy + local parity    ← requires part1 + part2 + part3

Phase 3 (resilience under sustained load)
  part1  RPC fallback URLs
  part2  Tavily + Relay response caching
  part3  Observability hooks (pool saturation, LLM latency)
```

## Local-dev guarantee

Every part lists a `How to verify locally` section. The existing `docker-compose.yml` already runs:
- `app` (Node process — `tsx watch src/telegramCli.ts`)
- `redis` (redis:7-alpine)
- `postgres` (postgres:16-alpine)

Phases 1 and 3 are pure code — no compose changes needed, `npm run dev` and `docker compose up` both keep working.

Phase 2 introduces a second entrypoint (`src/workerCli.ts`) and a way to run multiple `app` replicas. Part 4 adds:
- A compose profile to run N `app` replicas behind an nginx round-robin (simulates Cloud Run autoscale).
- Instructions to prove locally that a multi-step flow (`/send` → disambiguation → "yes") survives hitting different replicas.

No step introduces a dependency that only exists in production.

## Conventions to preserve (from `status.md` + `CLAUDE.md`)

- Hexagonal boundaries are real — new adapters implement existing ports, DI wiring only in `src/adapters/inject/assistant.di.ts`.
- No hardcoded chain config — extend `src/helpers/chainConfig.ts` if needed.
- No raw SQL migrations — drizzle only.
- Every `process.env.X` read hoisted to a top-of-file `const`.
- Lazy singletons via `this._x ??= …`.
- Record new conventions in `be/STATUS.md`.

## Parts index

- [scaling-phase1-part1.md](scaling-phase1-part1.md) — DB pool + message query LIMIT
- [scaling-phase1-part2.md](scaling-phase1-part2.md) — LLM concurrency cap + prompt caching
- [scaling-phase1-part3.md](scaling-phase1-part3.md) — Privy token LRU cache
- [scaling-phase2-part1.md](scaling-phase2-part1.md) — Redis pending collection store
- [scaling-phase2-part2.md](scaling-phase2-part2.md) — Redis Telegram session cache
- [scaling-phase2-part3.md](scaling-phase2-part3.md) — Worker process split
- [scaling-phase2-part4.md](scaling-phase2-part4.md) — Cloud Run multi-replica + local parity
- [scaling-phase3-part1.md](scaling-phase3-part1.md) — RPC fallback URLs
- [scaling-phase3-part2.md](scaling-phase3-part2.md) — Tavily + Relay caching
- [scaling-phase3-part3.md](scaling-phase3-part3.md) — Observability hooks

## Order of operations

1. Phase 1 (all three parts, in any order) — merge and deploy.
2. Observe for 24 h; confirm no regressions.
3. Phase 2 parts 1 + 2 (Redis adapters) — merge, but deploy still single-replica.
4. Phase 2 part 3 (worker split) — merge, two processes but still `min/max=1` on Cloud Run.
5. Phase 2 part 4 (multi-replica) — flip Cloud Run `max-instances`. This is the scale-up moment.
6. Phase 3 opportunistically after load testing reveals real hot spots.

## Rollback posture

Phases 1 and 3 are per-file reverts. Phase 2 parts 1–3 are additive (new adapters, DI toggles); flipping the DI back to the in-memory impl restores prior behavior without DB migration. Phase 2 part 4 is a Cloud Run setting change — revert by setting `max-instances=1`.
