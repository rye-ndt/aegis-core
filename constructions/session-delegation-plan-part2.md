# Session Delegation — Backend Implementation Plan (Part 2 of 2)

> Date: 2026-04-11  
> Status: Draft (v3 — client-side signing; backend stores public metadata only)  
> Touches: `assistant.di.ts`, `.env.example`  
> **Prerequisite**: Complete Part 1 (`session-delegation-plan-part1.md`) first — Steps 1–6

---

## Step 5 — Edit `src/adapters/inject/assistant.di.ts`

Three changes: new imports, new private field, new getter method, update `getHttpApiServer()`.

### 5a — Add imports after the existing import block

```typescript
import { RedisSessionDelegationCache } from '../implementations/output/cache/redis.sessionDelegation';
import type { ISessionDelegationCache } from '../../use-cases/interface/output/cache/sessionDelegation.cache';
```

### 5b — Add private field inside the `AssistantInject` class

After `private _privyAuthService: PrivyServerAuthAdapter | null = null;`, add:

```typescript
  private _sessionDelegationCache: ISessionDelegationCache | null = null;
```

### 5c — Add getter method

Add this method **before** `getHttpApiServer()`:

```typescript
  getSessionDelegationCache(): ISessionDelegationCache | undefined {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) return undefined;
    if (!this._sessionDelegationCache) {
      this._sessionDelegationCache = new RedisSessionDelegationCache(redisUrl);
    }
    return this._sessionDelegationCache;
  }
```

### 5d — Update `getHttpApiServer()`

The existing call is:

```typescript
    return new HttpApiServer(
      this.getAuthUseCase(),
      null,
      port,
      process.env.JWT_SECRET,
      this.getIntentUseCase(),
      db.userProfiles,
      this.getTokenRegistryService(),
      this.getViemClient(),
      chainId,
      this.getToolRegistrationUseCase(),
    );
```

Append `this.getSessionDelegationCache()` as the last argument:

```typescript
    return new HttpApiServer(
      this.getAuthUseCase(),
      null,
      port,
      process.env.JWT_SECRET,
      this.getIntentUseCase(),
      db.userProfiles,
      this.getTokenRegistryService(),
      this.getViemClient(),
      chainId,
      this.getToolRegistrationUseCase(),
      this.getSessionDelegationCache(),   // NEW last arg
    );
```

---

## Step 6 — Update `.env.example`

Add at the end of the file:

```dotenv
# Redis connection URL for session delegation storage
REDIS_URL=redis://localhost:6379
```

---

## File creation order (Part 2 steps)

7. Edit `src/adapters/inject/assistant.di.ts` — imports, field, getter, updated `getHttpApiServer()` call
8. Edit `.env.example` — add `REDIS_URL`

---

## No other files change

- No DB schema changes (`schema.ts` untouched — Redis is separate from PostgreSQL)
- No `telegramCli.ts` changes
- No use-case implementations changed
- No existing HTTP routes changed — only new routes added
- No other `AssistantInject` methods changed — only new getter + the final arg of `getHttpApiServer()`

---

## Manual verification

### Start Redis locally

```bash
redis-server
```

### Add `REDIS_URL` to `.env`

```dotenv
REDIS_URL=redis://localhost:6379
```

### Start the backend

```bash
cd onchain-agent && npm run dev
```

### Test `POST /persistent`

```bash
curl -s -X POST http://localhost:4000/persistent \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "0x02a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "address": "0x1234567890123456789012345678901234567890",
    "smartAccountAddress": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    "signerAddress": "0x9999999999999999999999999999999999999999",
    "permissions": [{
      "tokenAddress": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      "maxAmount": "1000000000000000000",
      "validUntil": 1779000000
    }],
    "grantedAt": 1712000000
  }'
```

Expected response:

```json
{"address":"0x1234567890123456789012345678901234567890","saved":true}
```

### Test `GET /permissions`

```bash
curl -s "http://localhost:4000/permissions?public_key=0x1234567890123456789012345678901234567890"
```

Expected response: the full `DelegationRecord` JSON (no private key material).

### Inspect Redis directly

```bash
redis-cli get "delegation:0x1234567890123456789012345678901234567890"
```

Expected: the same JSON.

---

## API reference (new endpoints)

### `POST /persistent`

**Auth**: None  
**Body**: `DelegationRecord` (JSON, validated by `DelegationRecordSchema`). Contains only public metadata — no private key, no serialized session key blob.  
**Responses**:

| Status | Body |
|--------|------|
| 201 | `{ "address": "0x...", "saved": true }` |
| 400 | `{ "error": "Invalid JSON" }` or `{ "error": "Invalid delegation record", "details": [...] }` |
| 503 | `{ "error": "Session delegation store not available" }` (REDIS_URL not set) |

### `GET /permissions`

**Auth**: None  
**Query**: `public_key=0x{40 hex chars}` (the session key's Ethereum **address**)  
**Responses**:

| Status | Body |
|--------|------|
| 200 | Full `DelegationRecord` JSON (public metadata only) |
| 400 | `{ "error": "public_key query parameter is required" }` or address format error |
| 404 | `{ "error": "No delegation record found for this address" }` |
| 503 | `{ "error": "Session delegation store not available" }` (REDIS_URL not set) |

**Important naming note**: the query parameter is called `public_key` to match the frontend naming convention, but it must receive a 42-char Ethereum **address** (not the 68-char raw compressed public key). The parameter name is intentionally kept as `public_key` for API compatibility.

---

## Architecture note — how signing works

The backend plays no role in signing. When the agent needs to execute an on-chain action on behalf of a user:

1. The backend prepares the calldata (target address, encoded function call, value)
2. The backend sends this to the frontend via a Telegram bot message containing a mini app button
3. The user taps the button; the mini app opens
4. The mini app decrypts the session key from Telegram CloudStorage using the user's password
5. The mini app calls `deserializePermissionAccount` locally to reconstruct a ZeroDev signing account
6. The mini app creates a `KernelAccountClient` and calls `sendUserOperation` directly to the ZeroDev bundler RPC
7. The mini app reports the tx hash back to the backend (or the backend observes on-chain)

The backend never touches a private key. The only trust assumption is that the ZeroDev bundler RPC and Kernel contract enforce the on-chain permission scope.
