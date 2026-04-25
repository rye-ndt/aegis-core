# Endpoint Auth Hardening — Plan

## Why
Audit (2026-04-25) found four HTTP endpoints open to unauthenticated callers:
- `POST /tools` — anyone can register a tool manifest.
- `POST /command-mappings`, `DELETE /command-mappings/:command` — anyone can hijack command routing.
- `GET /permissions?public_key=` — leaks session-key delegation by address.
- `GET /request/:requestId` (no `?after=`) — returns any pending request to anyone with the UUID.

We will close these by **reusing the existing Privy token** plus a tiny admin allowlist. No new auth mechanism, no new ports/adapters, no schema change.

## Scope
- All changes in `src/adapters/implementations/input/http/httpServer.ts`.
- One new env var: `ADMIN_PRIVY_DIDS`.
- Rate limiting deliberately **out of scope** (deferred — see "Deferred" below).

## Building blocks

### 1. `ADMIN_PRIVY_DIDS` env var
- Comma-separated list of Privy DIDs.
- Hoisted at top of `httpServer.ts` per the codebase convention:
  ```ts
  const ADMIN_PRIVY_DIDS = new Set(
    (process.env.ADMIN_PRIVY_DIDS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  );
  ```
- Document in `STATUS.md` env table after implementation.

### 2. `requireAdmin(req)` helper
Sibling to existing `extractUserId(req)`. Resolves Privy token → looks up `user.privyDid` → checks `ADMIN_PRIVY_DIDS`. Returns the userId on success so handlers can still log who acted; returns `null` (caller writes 401/403) otherwise.

```ts
private async requireAdmin(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const userId = await this.extractUserId(req);
  if (!userId) { this.json(res, 401, { error: "unauthorized" }); return null; }
  const user = await this.authUseCase.getUserById(userId); // or whichever existing lookup returns privyDid
  if (!user || !ADMIN_PRIVY_DIDS.has(user.privyDid)) {
    log.warn({ userId }, "admin-forbidden");
    this.json(res, 403, { error: "forbidden" });
    return null;
  }
  return userId;
}
```
**Open question:** which existing method on `IAuthUseCase` / `IUserRepo` returns a user's `privyDid` from `userId`? If none exists, add one (`getPrivyDidByUserId(userId)`) — single field lookup, no new port.

## Endpoint changes

### `GET /request/:requestId` (base path, no `?after=`)
Fetch the request first. Then:
- If `request.requestType === 'auth'` → return as today (chicken-and-egg: caller doesn't have a Privy token yet).
- Else → require Privy + verify `request.userId === caller.userId`. 401 if no token, 403 if mismatch.

```ts
const stored = await cache.get(requestId);
if (!stored) return this.json(res, 404, { error: "not_found" });
if (expired(stored)) return this.json(res, 410, { error: "expired" });

if (stored.requestType !== 'auth') {
  const userId = await this.extractUserId(req);
  if (!userId) return this.json(res, 401, { error: "unauthorized" });
  if (stored.userId !== userId) return this.json(res, 403, { error: "forbidden" });
}
return this.json(res, 200, stored);
```

### `GET /permissions?public_key=`
Require Privy. Look up caller's SCA via `userProfileRepo.findByUserId(userId)`. 403 if `public_key.toLowerCase() !== profile.smartAccountAddress.toLowerCase()`.

### `POST /tools`
First line of handler: `const userId = await this.requireAdmin(req, res); if (!userId) return;` Log the userId on the registration log line.

### `POST /command-mappings`, `DELETE /command-mappings/:command`
Same pattern as `POST /tools`.

## Logging
Per CLAUDE.md logging convention:
- Successful admin action: `log.info({ userId, route }, "admin-action")`.
- Forbidden attempts: `log.warn({ userId, route }, "admin-forbidden")`.
- Ownership mismatch on `/request/:id`: `log.warn({ requestId, callerUserId: userId, ownerUserId: stored.userId }, "request-ownership-mismatch")`.

Never log the bearer token. `userId` is fine.

## Rollout
Atomic with FE — see `fe/privy-auth/constructions/endpoint-auth-hardening-plan.md`. The `GET /request/:id` change will 401 the mini-app's polling for sign/approve requests until the FE sends the Bearer header.

If atomic is impractical, fallback is two-phase: ship BE with the auth check in **log-only** mode (compute the would-be result, log mismatches, but still return 200) for one release, then flip after FE rolls out. Adds ~5 lines of throwaway code; remove on flip.

## Deferred (intentional)
- **Rate limiting** on the still-unauthenticated `GET /request/:id` `auth`-type bootstrap path. The defense today is the unguessable UUID + 600s TTL. Add an in-process token bucket (per-IP, ~60 req/min) when we see abuse signal or before opening Telegram bot to a wider audience.
- **`users.role` column** — env-var allowlist is right-sized for current admin count (≤3). Promote when the list outgrows env vars.
- **mTLS / OAuth client credentials / per-key audit logs** — overkill for current scale.

## STATUS.md updates after merge
- Mark `POST /tools`, `POST /command-mappings`, `GET /permissions`, `GET /request/:id` as authenticated/admin in the HTTP API table.
- Add `ADMIN_PRIVY_DIDS` to env-vars table.
- Add a "Endpoint auth hardening — 2026-04-25" feature-log entry.

## Open questions before implementation
1. Who are the admin Privy DIDs? Just yours, or are there others?
2. Atomic ship (one PR spanning BE+FE) or two-phase log-only first? Default = atomic.
3. Confirm: does any `IAuthUseCase` / `IUserRepo` method currently return `privyDid` from `userId`? If not, OK to add a one-liner `getPrivyDidByUserId`?
