# Scaling Phase 2 — Part 2: Remove the in-process Telegram session cache

> Prerequisites: Phase 1 parts 1–3 merged.
> Blocks: part 4 (multi-replica deploy) cannot ship until this + part 1 are done.
> Behavior change: **none.** Session lookup result is identical; latency per Telegram message goes up by one primary-key DB lookup (~1–3 ms), which the existing DB pool easily absorbs.

## Why

`src/adapters/implementations/input/telegram/handler.ts:19`:

```ts
private sessionCache = new Map<number, { userId: string; expiresAtEpoch: number }>();
```

This is an in-process read-through cache in front of `telegramSessions` (Postgres). Sites: declaration (`:19`), delete on logout (`:87`), set on auth (`:175`), read (`:185`), invalidate-on-expiry (`:188-189`), set after DB lookup (`:198`).

Under multi-replica deploy, this cache becomes actively harmful:

- Replica A caches `{chatId → userId}` on auth.
- User sends next message → routed to replica B → B's cache is empty → B queries DB → works.
- User logs out from a request landing on A → A deletes from its cache and DB. Replica B still has it cached → B serves the user as authenticated for up to `expiresAtEpoch` after the logout. **Security regression.**

## Decision: remove the cache, do not replace it with Redis

The canonical session data lives in Postgres (`telegramSessions` table, keyed by `chat_id`, indexed). Access pattern:

- Throughput: a single chat user sends < 1 msg / 30 s on average. 200 users → ~7 requests/s across all replicas hit `ensureAuthenticated`.
- Query shape: `SELECT … FROM telegram_sessions WHERE chat_id = $1 LIMIT 1` — single-row, PK/index hit, sub-ms server-side.
- Pool budget (after Phase 1 Part 1): 25 conns/replica × 4–8 replicas = 100–200 total. 7 qps on one lookup is noise.

A Redis read-through cache would save 1–3 ms per request at the cost of a Redis round-trip (1–3 ms). Net zero, and adds a stale-read risk on logout. **Not worth the code.**

## Step 2.1 — Strip the cache from `TelegramAssistantHandler`

Edit `src/adapters/implementations/input/telegram/handler.ts`.

### 2.1.1 — Remove the field (line 19)

Delete:
```ts
private sessionCache = new Map<number, { userId: string; expiresAtEpoch: number }>();
```

### 2.1.2 — Simplify `ensureAuthenticated` (around lines 182–200)

The current body (read the file for exact lines, the pattern is):

```ts
const cached = this.sessionCache.get(chatId);
if (cached) {
  if (cached.expiresAtEpoch > newCurrentUTCEpoch()) return cached;
  this.sessionCache.delete(chatId);
  await this.telegramSessions.deleteByChatId(String(chatId));
  return null;
}
const session = await this.telegramSessions.findByChatId(String(chatId));
if (!session) return null;
if (session.expiresAtEpoch <= newCurrentUTCEpoch()) {
  await this.telegramSessions.deleteByChatId(String(chatId));
  return null;
}
this.sessionCache.set(chatId, { userId: session.userId, expiresAtEpoch: session.expiresAtEpoch });
return { userId: session.userId, expiresAtEpoch: session.expiresAtEpoch };
```

Replace with:

```ts
const session = await this.telegramSessions.findByChatId(String(chatId));
if (!session) return null;
if (session.expiresAtEpoch <= newCurrentUTCEpoch()) {
  await this.telegramSessions.deleteByChatId(String(chatId));
  return null;
}
return { userId: session.userId, expiresAtEpoch: session.expiresAtEpoch };
```

### 2.1.3 — Strip other cache touches

- Line 87 (`this.sessionCache.delete(chatId);` in logout): delete this line. The DB delete that precedes it is sufficient.
- Line 175 (`this.sessionCache.set(...)` after auth): delete this line. The DB upsert that precedes it is sufficient.
- Anywhere else `sessionCache` appears: remove.

Run:
```
grep -n sessionCache src/adapters/implementations/input/telegram/handler.ts
```
Should return zero lines after edits.

## Step 2.2 — Verify session TTL is still enforced

The `telegramSessions.findByChatId` impl at `src/adapters/implementations/output/sqlDB/repositories/telegramSession.repo.ts` returns rows without expiry-filtering by default. `ensureAuthenticated`'s post-read check at the comparison against `expiresAtEpoch` handles this. Confirm by reading the repo method; no change needed unless the repo itself silently filters expired rows (it doesn't).

If the repo later adds an internal expiry filter, the `expiresAtEpoch <= now` branch in `ensureAuthenticated` becomes dead — that's fine, just drop it then.

## How to verify locally

1. `docker compose up -d postgres redis` and `npm run dev`.
2. Telegram `/auth <token>` to log in. Confirm welcome message.
3. `SELECT chat_id, user_id, expires_at_epoch FROM telegram_sessions WHERE chat_id = '<your_chat_id>';` — row exists.
4. Send any message — bot responds.
5. `/logout` — row should be gone from `telegram_sessions`.
6. Send any message — bot asks you to auth again. No stale cache behavior.
7. **Multi-process test** (proves the fix):
   - Terminal A: `PORT=4000 npm run dev`
   - Terminal B: `PORT=4001 npm run dev`
   - Only one process can long-poll Telegram at a time (grammy's default `bot.start()` holds the long-poll lease). Either:
     - (a) Stop A, run B, test with Telegram → works because B reads from DB.
     - (b) Use the HTTP path: `curl -X POST localhost:4001/auth/privy …` then `curl -X POST localhost:4000/chat …` — both processes see the same session.
8. `npx tsc --noEmit` — clean.

## Rollback

Revert the handler file. No DB, no schema, no data.

## Acceptance

- Compile clean.
- Login/logout flow works.
- `grep sessionCache` returns zero hits in `handler.ts`.
- `telegramSessions.findByChatId` invocation count per message = 1 (it was 0 before on cache hit, 1 on cache miss; now always 1). Observed via optional debug log.
- Two-process test: session created on one process is visible on the other with no delay.

## Record in STATUS.md

```
- 2026-04-24 — Removed `sessionCache` in-memory map from
  `TelegramAssistantHandler`. Session is now always read from Postgres
  (`telegram_sessions` indexed on chat_id). Multi-replica-safe. Cost: one
  extra PK lookup per Telegram message (~1–3 ms, negligible).
  Do not reintroduce an in-process cache without addressing cross-replica
  logout staleness first.
```
