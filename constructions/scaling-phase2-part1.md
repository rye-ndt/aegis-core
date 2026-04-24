# Scaling Phase 2 — Part 1: Redis pending collection store

> Prerequisites: Phase 1 parts 1–3 merged and observed for 24 h.
> Blocks: part 4 (multi-replica deploy) cannot ship until this + part 2 are done.
> Behavior change: **none** when `REDIS_URL` is set and DI wires the Redis impl. With `REDIS_URL` unset the in-memory impl stays, single-replica behavior unchanged.

## Why

`src/adapters/implementations/output/pendingCollectionStore/inMemory.ts:8`:

```ts
private readonly map = new Map<string, PendingCollection>();
```

This is per-process. It holds the state machine for every multi-step capability (`/send Alice 10 USDC` → "did you mean Alice Evenson?" → "yes"). With two replicas behind a load balancer, the first message lands on replica A and writes to A's `Map`. The "yes" lands on replica B and finds… nothing. Flow dies silently.

This is the single biggest blocker for horizontal scaling. Fix it and we can scale.

The fix is trivial: there's already an `IPendingCollectionStore` port (`src/use-cases/interface/output/pendingCollectionStore.interface.ts`) and a well-established Redis adapter pattern (`src/adapters/implementations/output/cache/redis.*.ts`). Copy the pattern, flip a DI toggle.

## Scope check — callers of `IPendingCollectionStore`

Only one: `src/use-cases/implementations/capabilityDispatcher.usecase.ts:16`. Single construction site in DI at `assistant.di.ts:605`. Swap is safe.

## Step 1.1 — Write the Redis adapter

New file `src/adapters/implementations/output/pendingCollectionStore/redis.ts`:

```ts
import type Redis from "ioredis";
import type {
  IPendingCollectionStore,
  PendingCollection,
} from "../../../../use-cases/interface/output/pendingCollectionStore.interface";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";

// Hard ceiling so a stale/abandoned Redis row cannot live forever
// even if a capability forgets to call `clear()`. Individual
// pendings still honor their own `expiresAt`.
const MAX_TTL_SECONDS = 60 * 60; // 1 h

export class RedisPendingCollectionStore implements IPendingCollectionStore {
  constructor(private readonly redis: Redis) {}

  private key(channelId: string): string {
    return `pending_collection:${channelId}`;
  }

  async get(channelId: string): Promise<PendingCollection | null> {
    const raw = await this.redis.get(this.key(channelId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingCollection;
    if (parsed.expiresAt <= newCurrentUTCEpoch()) {
      // Stale — clean up and return null, preserving in-memory
      // adapter's contract (see inMemory.ts:10-13).
      await this.redis.del(this.key(channelId));
      return null;
    }
    return parsed;
  }

  async save(channelId: string, pending: PendingCollection): Promise<void> {
    const now = newCurrentUTCEpoch();
    const ttlFromPending = Math.max(1, pending.expiresAt - now);
    const ttl = Math.min(ttlFromPending, MAX_TTL_SECONDS);
    await this.redis.set(
      this.key(channelId),
      JSON.stringify(pending),
      "EX",
      ttl,
    );
  }

  async clear(channelId: string): Promise<void> {
    await this.redis.del(this.key(channelId));
  }
}
```

Notes:

- Contract matches `InMemoryPendingCollectionStore` exactly (same null-on-expired behavior, same `clear` semantics).
- TTL is driven by the pending's own `expiresAt`, so behavior mirrors in-memory expiration without a background reaper.
- `MAX_TTL_SECONDS = 1 h` is a safety belt; current `expiresAt` values from capabilities are minutes-scale, so this is never reached in practice.
- `PendingCollection.state` is `Record<string, unknown>` in the interface and is serialized via JSON. Review each capability's saved state for non-JSON-safe types (Date → epoch, BigInt → string) — grep `this.pending.save(` and audit. Today all capabilities already use JSON-safe shapes (epochs + strings); if a future capability regresses, this adapter will throw at `JSON.stringify` time and fail loud.

## Step 1.2 — DI wiring with backward-compat fallback

Edit `src/adapters/inject/assistant.di.ts`.

Add the new import at the top (next to existing `InMemoryPendingCollectionStore` import at line 74):

```ts
import { RedisPendingCollectionStore } from "../implementations/output/pendingCollectionStore/redis";
```

At line 605 (`const pending = new InMemoryPendingCollectionStore();`), change to:

```ts
const redisForPending = this.getRedis();
const pending: IPendingCollectionStore = redisForPending
  ? new RedisPendingCollectionStore(redisForPending)
  : new InMemoryPendingCollectionStore();
```

Add the type import at the top if not present:

```ts
import type { IPendingCollectionStore } from "../../use-cases/interface/output/pendingCollectionStore.interface";
```

Logic:
- If `REDIS_URL` is set → Redis impl (production, multi-replica-safe).
- If unset → in-memory (local quick tests where you don't want to run compose).
- No env flag required — presence of `REDIS_URL` is the switch. Matches existing patterns in `getSessionDelegationCache` (line 412) and `getMiniAppRequestCache` (line 420).

## Step 1.3 — Sanity check on PendingCollection serializability

Before merging, run:

```
grep -rn "pending.save(\|\.save(channelId" src/adapters/implementations/output/capabilities/ | head
```

For each callsite, open the capability and confirm the `state` field is a flat JSON-safe object. If any holds `Date`, `BigInt`, `Buffer`, or a function reference, fix there by converting to JSON-safe equivalents. Document in STATUS.md if you find one.

## How to verify locally

1. `docker compose up -d postgres redis`.
2. `npm run dev`.
3. In Telegram, start a multi-step flow: `/send @someone 10 USDC`. Bot asks for disambiguation or confirmation.
4. Open Redis CLI against the compose instance:
   ```
   docker exec -it $(docker ps -qf "name=redis") redis-cli
   > KEYS pending_collection:*
   > GET pending_collection:<channelId>
   > TTL pending_collection:<channelId>
   ```
   Should show one key with TTL roughly equal to the capability's configured window.
5. Reply to the bot to continue the flow. The pending should disappear from Redis (`clear`) or update to the next step.
6. **Multi-replica simulation (local).** The real test is the flow surviving across processes. Start two dev processes pointed at the same Redis + Postgres:
   ```
   PORT=4000 npm run dev & PORT=4001 npm run dev &
   ```
   Route the first Telegram message at the first process (use the Telegram long-poll; only one bot can run — skip here) or drive the capability via HTTP:
   ```
   curl -X POST localhost:4000/chat -H '...' -d '{"message":"/send @someone 10 USDC"}'
   # Then continue the flow via the second process:
   curl -X POST localhost:4001/chat -H '...' -d '{"message":"yes"}'
   ```
   Flow should complete. Before this change it would fail because process 4001 has no memory of the pending.
7. Unset `REDIS_URL` and restart — everything still works (fallback to in-memory). Confirms backward-compat.
8. `npx tsc --noEmit` — clean.

## Rollback

Revert the DI edit → everything uses in-memory again. The new file can be left in place (dead code); remove it in a cleanup pass if rollback is permanent.

## Acceptance

- Compile clean.
- With `REDIS_URL` set, `KEYS pending_collection:*` shows active pendings during a multi-step flow; they disappear on flow completion.
- Multi-step flow completes successfully across two local processes (step 6 above).
- Without `REDIS_URL`, behavior is identical to pre-change.

## Record in STATUS.md

```
- 2026-04-24 — `IPendingCollectionStore` has a Redis-backed adapter
  (`pending_collection:{channelId}` keys, TTL = pending.expiresAt). DI picks
  Redis when `REDIS_URL` is set, otherwise in-memory. `PendingCollection.state`
  must stay JSON-safe (no Date/BigInt/Buffer) — Redis impl will throw on
  JSON.stringify otherwise.
```
