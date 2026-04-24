# Scaling Phase 1 — Part 3: Privy token LRU cache

> Prerequisite: none (Phase 1 parts are independent).
> Behavior change: **none.** Same authoritative verification; subsequent requests with the same token within 5 min skip the Privy round-trip.
> Expected capacity lift: small on its own (~5%), but removes a hidden per-request 100–300 ms remote call that will dominate P95 under load.

## Why

`src/use-cases/implementations/auth.usecase.ts:107-116`:

```ts
async resolveUserId(privyToken: string): Promise<string | null> {
  if (!this.privyAuthService) return null;
  try {
    const { privyDid } = await this.privyAuthService.verifyTokenLite(privyToken);
    const user = await this.userDB.findByPrivyDid(privyDid);
    return user?.id ?? null;
  } catch {
    return null;
  }
}
```

`verifyTokenLite` (at `src/adapters/implementations/output/privyAuth/privyServer.adapter.ts:69-72`) calls `this.client.verifyAuthToken(accessToken)` — a remote Privy API call — on **every** authenticated HTTP request. For the mini-app's portfolio/polling cadence, that's ~1–3 Privy calls per user per minute. At 200 users that's 600 external calls/minute; Privy has rate limits.

Privy tokens are JWTs — stateless by design. The right fix is an in-process LRU keyed by token hash (don't key by the raw token — it lands in memory dumps). TTL 5 min is well under Privy's default JWT expiry.

## Decision: where to cache

Cache inside the adapter (`privyServer.adapter.ts`), not in the use-case. The port's contract — "verify and return `privyDid`" — is unchanged; the adapter's internal caching is an implementation detail, which is exactly what the hexagonal boundary is for. The use-case stays pure.

## Step 3.1 — Add `lru-cache` dependency

```
cd be && npm install lru-cache@11
```

Commit `package.json` + `package-lock.json`.

## Step 3.2 — Cache inside the Privy adapter

Edit `src/adapters/implementations/output/privyAuth/privyServer.adapter.ts`.

Add imports at the top (alongside existing ones):

```ts
import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";
```

Add top-of-file constants:

```ts
const PRIVY_VERIFY_CACHE_TTL_MS = Number(process.env.PRIVY_VERIFY_CACHE_TTL_MS ?? 5 * 60_000);
const PRIVY_VERIFY_CACHE_MAX = Number(process.env.PRIVY_VERIFY_CACHE_MAX ?? 5_000);
```

Inside the class, after the existing `this.client = …` in the constructor, add the cache field:

```ts
private readonly verifyLiteCache = new LRUCache<string, { privyDid: string }>({
  max: PRIVY_VERIFY_CACHE_MAX,
  ttl: PRIVY_VERIFY_CACHE_TTL_MS,
});

private hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

Replace `verifyTokenLite` (lines ~69–72):

```ts
async verifyTokenLite(accessToken: string): Promise<{ privyDid: string }> {
  const key = this.hashToken(accessToken);
  const cached = this.verifyLiteCache.get(key);
  if (cached) return cached;
  const claims = await this.client.verifyAuthToken(accessToken);
  const result = { privyDid: claims.userId };
  this.verifyLiteCache.set(key, result);
  return result;
}
```

Keep the heavier `verifyAuthToken` / signing-capable method at line 13 uncached — that one may need full claims, and it's called infrequently. If profiling later shows it's hot, apply the same pattern.

## Step 3.3 — Env in `.env.example`

Append under `# Scaling — Phase 1`:

```
PRIVY_VERIFY_CACHE_TTL_MS=300000
PRIVY_VERIFY_CACHE_MAX=5000
```

## Why not Redis for this

- Privy tokens expire within ~1 hour; LRU with 5-min TTL is already well-scoped.
- In-process LRU is free and zero-latency. Redis adds a round-trip that may cost more than the 100 ms Privy call it saves.
- Cross-replica sharing is not useful here — the same user may hit different replicas, but each replica's cache fills on first touch and stays warm. Worst case: each replica re-verifies the same token once. That's acceptable for 5,000 unique tokens × 8 replicas = 40k API calls cold-start, then effectively zero until TTL rolls.
- If Phase 3 observability shows > 10% cold-misses on verify, promote to Redis (reuse the existing `getRedis()` pattern from `assistant.di.ts:401`).

## How to verify locally

1. `docker compose up -d postgres redis` and `npm run dev`.
2. Open the mini-app and log in (generates a Privy token).
3. Hit an authenticated endpoint (e.g. `/portfolio`) twice in quick succession.
4. Inspect network traffic or add a one-off `console.log("[PrivyAdapter] hit verifyAuthToken remote")` at the line before `await this.client.verifyAuthToken(accessToken)`. First request → log fires. Second → silent. Third after 5 min → fires again.
5. Remove the temporary log before commit (it leaks token presence to stdout).
6. `npx tsc --noEmit` — clean.

## Rollback

One-file revert. No data, no schema. `lru-cache` dep can stay (used elsewhere likely in future parts).

## Acceptance

- Compile clean.
- Second call with same token within 5 min never hits Privy (verified via temporary log during testing).
- No regression on token expiry — after TTL elapses, the next verify re-validates (so revoked tokens stop working within 5 min, not forever).
- `findByPrivyDid` DB call still happens per `resolveUserId` — cache is on the adapter only. (DB call is cheap and user-status changes must be visible.)

## Record in STATUS.md

```
- 2026-04-24 — Privy `verifyTokenLite` now LRU-cached inside the adapter
  (sha256(token) → {privyDid}, TTL 5 min, max 5k entries). In-process only;
  revoked tokens remain valid in cache for up to PRIVY_VERIFY_CACHE_TTL_MS.
  If finer revocation is ever required, shorten the TTL or move to Redis.
```
