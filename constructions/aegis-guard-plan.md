# Aegis Guard — Backend Plan

## Overview

Add user preference persistence (`/preference`) and a delegation grant endpoint (`/aegis-guard/grant`) that stores the user's approved spending limits in Redis. Add cumulative spend tracking per token so the agent can enforce total limits application-side before submitting any UserOp.

---

## 1. New DB Table — `user_preferences`

File: `src/adapters/implementations/output/sqlDB/schema.ts`

```typescript
export const userPreferences = pgTable('user_preferences', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique(),
  aegisGuardEnabled: boolean('aegis_guard_enabled').notNull().default(false),
  updatedAtEpoch: integer('updated_at_epoch').notNull(),
});
```

One row per user (UNIQUE on `userId`). Use `INSERT ... ON CONFLICT DO UPDATE` (upsert).

Migration: `npm run db:generate && npm run db:migrate`

---

## 2. Repo Interface — `IUserPreferencesDB`

New file: `src/use-cases/interface/output/repository/userPreference.repo.ts`

```typescript
export interface IUserPreference {
  id: string;
  userId: string;
  aegisGuardEnabled: boolean;
  updatedAtEpoch: number;
}

export interface IUserPreferencesDB {
  upsert(userId: string, patch: { aegisGuardEnabled: boolean }): Promise<void>;
  findByUserId(userId: string): Promise<IUserPreference | null>;
}
```

---

## 3. Drizzle Implementation — `UserPreferencesRepo`

New file: `src/adapters/implementations/output/sqlDB/repositories/userPreference.repo.ts`

- `upsert`: `INSERT INTO user_preferences (...) VALUES (...) ON CONFLICT (user_id) DO UPDATE SET aegis_guard_enabled = EXCLUDED.aegis_guard_enabled, updated_at_epoch = EXCLUDED.updated_at_epoch`
- `findByUserId`: `SELECT * FROM user_preferences WHERE user_id = $1 LIMIT 1`
- ID generation: `newUuid()`
- Timestamp: `newCurrentUTCEpoch()`

Add `userPreferencesRepo: IUserPreferencesDB` property to `DrizzleSqlDB` class in `drizzleSqlDB.ts`.

---

## 4. Redis Cache — Aegis Guard

### 4a. Interface

New file: `src/use-cases/interface/output/cache/aegisGuard.cache.ts`

```typescript
export interface AegisGuardTokenDelegation {
  tokenAddress: string;   // checksummed ERC20 address
  tokenSymbol: string;
  tokenDecimals: number;
  limitWei: string;       // bigint serialised as decimal string
  validUntil: number;     // unix epoch seconds
}

export interface AegisGuardGrant {
  sessionKeyAddress: string;
  smartAccountAddress: string;
  delegations: AegisGuardTokenDelegation[];
  grantedAt: number;
}

export interface IAegisGuardCache {
  // store the full grant (what the user approved)
  saveGrant(userId: string, grant: AegisGuardGrant, ttlSeconds: number): Promise<void>;
  getGrant(userId: string): Promise<AegisGuardGrant | null>;

  // cumulative spend tracking per token
  addSpent(userId: string, tokenAddress: string, amountWei: string, ttlSeconds: number): Promise<string>; // returns new total as decimal string
  getSpent(userId: string, tokenAddress: string): Promise<string>; // "0" if key absent
}
```

### 4b. Redis Key Schema

| Key | Value | TTL |
|-----|-------|-----|
| `aegis_guard:grant:{userId}` | JSON-serialised `AegisGuardGrant` | `validUntil - now` of the furthest token (minimum 60 s) |
| `aegis_guard:spent:{userId}:{tokenAddress.toLowerCase()}` | decimal string (wei) | same TTL as grant |

### 4c. Implementation

New file: `src/adapters/implementations/output/cache/redis.aegisGuard.ts`

- `saveGrant`: `SET aegis_guard:grant:{userId} <json> EX <ttl>`
- `getGrant`: `GET` + `JSON.parse`; return `null` if missing
- `addSpent`: Lua script — `INCRBY` on the spent key (treating it as a decimal string via string arithmetic) with `EXPIRE` to keep TTL aligned. Use Redis `INCRBYFLOAT` is NOT safe for wei; use a Lua script that does string→BigInt arithmetic or store as integer wei in a separate integer key. Simplest: store wei amounts as integer strings and use `INCRBY` — valid since wei values are always integers.
- `getSpent`: `GET aegis_guard:spent:{userId}:{tokenAddress}` → return `"0"` if nil

---

## 5. New HTTP Routes

File: `src/adapters/implementations/input/http/httpServer.ts`

### 5a. `GET /preference`

- Auth: JWT required
- Calls: `db.userPreferencesRepo.findByUserId(userId)`
- Response 200: `{ aegisGuardEnabled: boolean }`
- If no row found: return `{ aegisGuardEnabled: false }` (treat absence as disabled)

### 5b. `POST /preference`

- Auth: JWT required
- Body schema (Zod):
  ```typescript
  z.object({ aegisGuardEnabled: z.boolean() })
  ```
- Calls: `db.userPreferencesRepo.upsert(userId, { aegisGuardEnabled })`
- Response 200: `{ ok: true }`

### 5c. `POST /aegis-guard/grant`

- Auth: JWT required
- Body schema (Zod):
  ```typescript
  z.object({
    sessionKeyAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    smartAccountAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    delegations: z.array(z.object({
      tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      tokenSymbol: z.string().min(1).max(10),
      tokenDecimals: z.number().int().min(0).max(18),
      limitWei: z.string().regex(/^\d+$/),   // decimal integer string
      validUntil: z.number().int().positive(),
    })).min(1),
  })
  ```
- Logic:
  1. Validate body
  2. Compute TTL: `Math.max(...delegations.map(d => d.validUntil)) - newCurrentUTCEpoch()`; clamp to minimum 60 s
  3. `aegisGuardCache.saveGrant(userId, { sessionKeyAddress, smartAccountAddress, delegations, grantedAt: now }, ttl)`
  4. `db.userPreferencesRepo.upsert(userId, { aegisGuardEnabled: true })`
  5. Response 200: `{ ok: true }`

Route pattern in router: exact match `pathname === '/aegis-guard/grant' && method === 'POST'`

---

## 6. Wiring — `assistant.di.ts`

Add to the DI container:

```typescript
private _aegisGuardCache?: IAegisGuardCache;
get aegisGuardCache(): IAegisGuardCache {
  return (this._aegisGuardCache ??= new RedisAegisGuardCache(this.redis));
}
```

Pass `aegisGuardCache` and `db.userPreferencesRepo` into the HTTP handler constructor (or directly reference from the DI singleton — follow existing pattern).

---

## 7. Cumulative Spend Enforcement (future agent integration — noted here, not built now)

When the agent executes a trade on behalf of a user, before submitting the UserOp:

1. `aegisGuardCache.getGrant(userId)` — confirm guard is active and delegation covers the token
2. `aegisGuardCache.getSpent(userId, tokenAddress)` — fetch cumulative spent
3. Check: `BigInt(spent) + BigInt(tradeAmountWei) <= BigInt(delegation.limitWei)` — reject if exceeded
4. After successful on-chain execution: `aegisGuardCache.addSpent(userId, tokenAddress, tradeAmountWei, ttl)`

This is not built as part of this feature but the cache interface is designed to support it.

---

## 8. File Checklist

| Action | File |
|--------|------|
| Add table | `src/adapters/implementations/output/sqlDB/schema.ts` |
| Add interface | `src/use-cases/interface/output/repository/userPreference.repo.ts` |
| Add interface | `src/use-cases/interface/output/cache/aegisGuard.cache.ts` |
| New file | `src/adapters/implementations/output/sqlDB/repositories/userPreference.repo.ts` |
| New file | `src/adapters/implementations/output/cache/redis.aegisGuard.ts` |
| Add routes | `src/adapters/implementations/input/http/httpServer.ts` |
| Add property | `src/adapters/implementations/output/sqlDB/drizzleSqlDB.ts` |
| Wire DI | `src/adapters/inject/assistant.di.ts` |
| Migration | `npm run db:generate && npm run db:migrate` |
