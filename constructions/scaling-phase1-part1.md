# Scaling Phase 1 — Part 1: DB pool + message query LIMIT

> Prerequisite: none.
> Blocks: nothing (parts 1–3 of Phase 1 are independent).
> Behavior change: **none.** Same queries, different pool capacity and different `ORDER BY … LIMIT` shape on one read.
> Expected capacity lift (with part 2): ~10 → ~30 users on current single-process deploy.

## Why

- `src/adapters/implementations/output/sqlDB/drizzlePostgres.db.ts:20-23` constructs `new Pool(...)` with no `max`. Node `pg` defaults to **10 connections**. Five queries per chat request × ten users exhausts it; further requests queue on `pg`'s connect wait.
- `src/use-cases/implementations/assistant.usecase.ts:51` calls `this.messageRepo.findByConversationId(conversationId)` then `slice(-20)` at line 60. The repo at `src/adapters/implementations/output/sqlDB/repositories/message.repo.ts:27` does `SELECT *` over the whole conversation. For chatty users this grows O(N) on every turn.

Fix both in the same part — they touch the same layer and can ship atomically.

## Step 1.1 — Configure the Postgres pool

Edit `src/adapters/implementations/output/sqlDB/drizzlePostgres.db.ts`.

Add top-of-file constants after the existing imports (respect the "hoist env reads" convention):

```ts
const POOL_MAX = Number(process.env.DB_POOL_MAX ?? 25);
const POOL_IDLE_TIMEOUT_MS = Number(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? 30_000);
const POOL_CONNECTION_TIMEOUT_MS = Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS ?? 5_000);
```

Change the `Pool` construction at line 20–23 from:

```ts
this.pool = "connectionString" in config
  ? new Pool({ connectionString: config.connectionString })
  : new Pool(config);
```

to:

```ts
const poolOptions = {
  max: POOL_MAX,
  idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
};
this.pool = "connectionString" in config
  ? new Pool({ connectionString: config.connectionString, ...poolOptions })
  : new Pool({ ...config, ...poolOptions });
```

### Sizing rationale

- Cloud Run will run 2–8 replicas (Phase 2 part 4). Managed Postgres small tier supports ~200 connections total.
- Budget: `max_replicas × POOL_MAX` + worker + drizzle migrations + studio ≤ 0.8 × server max_connections.
- 8 replicas × 25 = 200. Leaves 100 head-room for worker (25), migrations transient, studio. If we upgrade past 8 replicas, drop `POOL_MAX` to 20 or upsize Postgres.
- Locally (single process): 25 is plenty; no observable cost.

## Step 1.2 — Push `LIMIT` into the message query

Edit `src/use-cases/interface/output/repository/message.repo.ts`:

Change line 16 from:

```ts
findByConversationId(conversationId: string): Promise<Message[]>;
```

to:

```ts
findByConversationId(conversationId: string, limit?: number): Promise<Message[]>;
```

Edit `src/adapters/implementations/output/sqlDB/repositories/message.repo.ts` at the method starting line 27:

```ts
async findByConversationId(conversationId: string, limit?: number): Promise<Message[]> {
  let query = this.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAtEpoch));
  const rows = limit === undefined
    ? await query
    : await query.limit(limit);
  return rows.slice().reverse().map(mapRow);
}
```

Notes:
- `desc(…)` + `.slice().reverse()` keeps callers receiving ascending-by-time rows — **no behavior change** for any current caller.
- `limit` is optional so the other caller (`intent.usecase.ts:68`) keeps working without edits.
- If `desc` is not yet imported, add `desc` to the existing `import { … } from "drizzle-orm"` line.

Edit `src/use-cases/implementations/assistant.usecase.ts`:

Add top-of-file constant after the existing imports:

```ts
const MESSAGE_HISTORY_LIMIT = Number(process.env.MESSAGE_HISTORY_LIMIT ?? 30);
```

At line 51, change:

```ts
this.messageRepo.findByConversationId(conversationId),
```

to:

```ts
this.messageRepo.findByConversationId(conversationId, MESSAGE_HISTORY_LIMIT),
```

At line 60, keep `.slice(-20)`. We now fetch 30 and slice the last 20; the extra 10-row buffer is a safety margin (compaction work in `be/STATUS.md` may eventually change the slice size; the fetch still caps at 30).

## Step 1.3 — Env vars in `.env.example` + `docker-compose.yml`

Add to `.env.example` (create section `# Scaling — Phase 1`):

```
DB_POOL_MAX=25
DB_POOL_IDLE_TIMEOUT_MS=30000
DB_POOL_CONNECTION_TIMEOUT_MS=5000
MESSAGE_HISTORY_LIMIT=30
```

No change to `docker-compose.yml` needed — `env_file: .env` already plumbs them in.

## How to verify locally

1. `docker compose up -d postgres redis`
2. `npm run dev`
3. In a second terminal, inspect pool config:
   ```
   docker exec -it $(docker ps -qf "name=postgres") psql -U postgres -d jarvis \
     -c "SELECT count(*), state FROM pg_stat_activity WHERE datname = 'jarvis' GROUP BY state;"
   ```
   After the app connects, you should see idle connections up to `POOL_MAX=25` — the pool is lazy so actual count depends on traffic, but cap should never be exceeded.
4. Drive chat traffic (Telegram or `curl` to HTTP API) for a conversation with > 30 messages, then check logs:
   - `[AssistantUseCase] chat start … historyLength=21` (20 history + 1 new) — unchanged.
   - No new "slow query" log from postgres for `SELECT … FROM messages` on large conversations.
5. Run `npx tsc --noEmit` from `be/` — must be clean.
6. Run `npm test` (or whichever test entrypoint is configured) — no regressions in message-repo tests.

## Rollback

- Revert the three files. No DB migration, no schema change, no data change.
- Env vars become no-ops; remove from `.env.example` if desired.

## Acceptance

- Compile clean.
- Pool cap configurable via env.
- Message read path logs the same `historyLength` as before.
- On a conversation with 1000 messages, the returned list is 20 most recent, and query plan shows `LIMIT 30` (verify with `EXPLAIN ANALYZE` in psql if curious).

## Record in STATUS.md

Append under a `## Scaling` section:

```
- 2026-04-24 — DB pool now `max: 25` (env-tunable via DB_POOL_MAX). Total Postgres
  connection budget = replicas × POOL_MAX + 1 worker pool. Do not raise per-replica
  POOL_MAX without re-budgeting.
- 2026-04-24 — `IMessageDB.findByConversationId` accepts optional `limit`; assistant
  chat path caps at MESSAGE_HISTORY_LIMIT=30 rows (ORDER BY created_at DESC LIMIT N,
  reversed to ascending). Preserves behavior of later `.slice(-20)`.
```
