# Session Delegation — Backend Implementation Plan

> Date: 2026-04-10  
> Status: Draft (v2 — ZeroDev on-chain session keys)  
> Touches: `httpServer.ts`, `assistant.di.ts`, `.env.example`, new port + adapter files

---

## Goal

Add two new HTTP endpoints that persist and retrieve session key delegation records:

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| `POST` | `/persistent` | None | Store a delegation record (public key + address + permissions + EIP-712 signature) in Redis |
| `GET` | `/permissions?public_key=0x...` | None | Retrieve the stored delegation record for a given Ethereum address |

No JWT auth on these endpoints. They are called by the Telegram Mini App frontend during onboarding, before the user has a server-side JWT.

Storage backend: Redis (ioredis). Each delegation record is stored under `delegation:{address}` (lowercased Ethereum address, 42 chars).

---

## Data model

These types are defined in the new port file and re-used in `httpServer.ts`.

```typescript
type Permission = {
  tokenAddress: string;    // 0x + 40 hex chars (ERC-20 or native sentinel)
  maxAmount: string;       // amount in wei as decimal string
  validUntil: number;      // Unix epoch seconds
};

type DelegationRecord = {
  publicKey: string;                // 0x-prefixed compressed secp256k1 public key
  address: string;                  // 0x + 40 hex chars Ethereum address (session key address)
  smartAccountAddress: string;      // User's Privy ERC-4337 Kernel smart account
  signerAddress: string;            // User's Privy embedded wallet (EOA, owns the Kernel account)
  permissions: Permission[];
  serializedSessionKey: string;     // base64 blob from serializePermissionAccount(); embeds session private key
  grantedAt: number;                // Unix epoch seconds
};
```

### How the backend uses `serializedSessionKey`

The frontend calls `serializePermissionAccount(kernelAccount, sessionPrivateKey)` from `@zerodev/permissions`
after installing the session key on-chain (via a UserOperation signed by the Privy embedded wallet).
The resulting base64 blob embeds the session private key **and** all on-chain proof data.

The backend reconstructs a live signing account with:

```typescript
import { deserializePermissionAccount } from '@zerodev/permissions';
import { KERNEL_V3_1 } from '@zerodev/sdk/constants';

const account = await deserializePermissionAccount(
  publicClient,
  entryPoint,   // getEntryPoint('0.7')
  KERNEL_V3_1,
  record.serializedSessionKey,
);
// account is a full KernelSmartAccount — can send UserOps with no user interaction
```

The backend does **not** need `@zerodev/permissions` installed today — the current plan only stores and
retrieves the blob. Add the ZeroDev packages and `ZERODEV_RPC` to the backend in a future step when
autonomous UserOp submission is implemented.

Redis key: `delegation:{record.address.toLowerCase()}`

---

## Step 1 — Install `ioredis`

Run from `onchain-agent/`:

```bash
npm install ioredis
```

`ioredis` v5+ ships native TypeScript types; no `@types/ioredis` needed.

---

## Step 2 — Create `src/use-cases/interface/output/cache/sessionDelegation.cache.ts`

New file in a new directory. This is the port (interface only — no implementation).

```typescript
export type Permission = {
  tokenAddress: string;
  maxAmount: string;
  validUntil: number;
};

export type DelegationRecord = {
  publicKey: string;
  address: string;
  smartAccountAddress: string;
  signerAddress: string;
  permissions: Permission[];
  serializedSessionKey: string;   // base64 blob from serializePermissionAccount(); embeds session private key
  grantedAt: number;
};

export interface ISessionDelegationCache {
  save(record: DelegationRecord): Promise<void>;
  findByAddress(address: string): Promise<DelegationRecord | null>;
}
```

Create the `cache/` directory inside `src/use-cases/interface/output/` — it does not exist yet.

---

## Step 3 — Create `src/adapters/implementations/output/cache/redis.sessionDelegation.ts`

New file in a new directory. Implements `ISessionDelegationCache` using ioredis.

```typescript
import Redis from 'ioredis';
import type {
  ISessionDelegationCache,
  DelegationRecord,
} from '../../../../use-cases/interface/output/cache/sessionDelegation.cache';

export class RedisSessionDelegationCache implements ISessionDelegationCache {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: false });
    this.redis.on('error', (err: Error) => {
      console.error('[Redis] connection error:', err.message);
    });
  }

  private key(address: string): string {
    return `delegation:${address.toLowerCase()}`;
  }

  async save(record: DelegationRecord): Promise<void> {
    await this.redis.set(this.key(record.address), JSON.stringify(record));
  }

  async findByAddress(address: string): Promise<DelegationRecord | null> {
    const raw = await this.redis.get(this.key(address));
    if (!raw) return null;
    return JSON.parse(raw) as DelegationRecord;
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
```

Create the `cache/` directory inside `src/adapters/implementations/output/` — it does not exist yet.

---

## Step 4 — Edit `src/adapters/implementations/input/http/httpServer.ts`

Four changes to this file: new import, two Zod schemas, one constructor param, two route dispatches, two handler methods, CORS support.

### 4a — Add import at the top

After the existing imports, add:

```typescript
import type { ISessionDelegationCache } from '../../../../use-cases/interface/output/cache/sessionDelegation.cache';
```

### 4b — Add Zod schemas after the existing `ERC20_BALANCE_ABI` constant

```typescript
const PermissionSchema = z.object({
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  maxAmount: z.string().regex(/^\d+$/),
  validUntil: z.number().int().positive(),
});

const DelegationRecordSchema = z.object({
  publicKey: z.string().min(1),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  smartAccountAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  signerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  permissions: z.array(PermissionSchema).min(1),
  serializedSessionKey: z.string().min(1),   // base64 blob from serializePermissionAccount()
  grantedAt: z.number().int().positive(),
});
```

### 4c — Add constructor parameter

The current last constructor parameter is `private readonly toolRegistrationUseCase?: IToolRegistrationUseCase`. Add one more **after** it:

```typescript
  private readonly sessionDelegationCache?: ISessionDelegationCache,
```

The complete constructor signature becomes:

```typescript
constructor(
  private readonly authUseCase: IAuthUseCase,
  _unused: null,
  private readonly port: number,
  private readonly jwtSecret?: string,
  private readonly intentUseCase?: IIntentUseCase,
  private readonly userProfileDB?: IUserProfileDB,
  private readonly tokenRegistryService?: ITokenRegistryService,
  private readonly viemClient?: ViemClientAdapter,
  private readonly chainId?: number,
  private readonly toolRegistrationUseCase?: IToolRegistrationUseCase,
  private readonly sessionDelegationCache?: ISessionDelegationCache,  // NEW
) {
```

Do not change the `http.createServer` call inside the constructor.

### 4d — Add CORS support at the top of `handle()`

In the `private async handle(...)` method, add these lines **immediately after** `const method = req.method?.toUpperCase();` and **before** any route dispatch:

```typescript
    // CORS — allow the mini app dev server and any deployed origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
```

### 4e — Add route dispatches to `handle()`

In the dispatch block of `handle()`, add these two lines **before** the `res.writeHead(404)` fallback:

```typescript
    if (method === 'POST' && url.pathname === '/persistent') {
      return this.handlePostPersistent(req, res);
    }
    if (method === 'GET' && url.pathname === '/permissions') {
      return this.handleGetPermissions(req, res, url);
    }
```

### 4f — Add two handler methods

Add both methods to the class body, after `handleDeleteTool` and before `extractUserId`. The exact position does not matter as long as they are inside the class.

#### `handlePostPersistent`

```typescript
  private async handlePostPersistent(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.sessionDelegationCache) {
      return this.sendJson(res, 503, { error: 'Session delegation store not available' });
    }

    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch {
      return this.sendJson(res, 400, { error: 'Invalid JSON' });
    }

    const parsed = DelegationRecordSchema.safeParse(body);
    if (!parsed.success) {
      return this.sendJson(res, 400, {
        error: 'Invalid delegation record',
        details: parsed.error.issues,
      });
    }

    await this.sessionDelegationCache.save(parsed.data);
    console.log(`[Delegation] Stored record for address ${parsed.data.address}`);
    return this.sendJson(res, 201, { address: parsed.data.address, saved: true });
  }
```

#### `handleGetPermissions`

```typescript
  private async handleGetPermissions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this.sessionDelegationCache) {
      return this.sendJson(res, 503, { error: 'Session delegation store not available' });
    }

    const param = url.searchParams.get('public_key');
    if (!param) {
      return this.sendJson(res, 400, { error: 'public_key query parameter is required' });
    }

    // The query parameter must be a 42-char Ethereum address (0x + 40 hex).
    // The frontend should pass `delegatedAddress` (the address field of the keypair),
    // NOT the raw compressed public key.
    if (!/^0x[0-9a-fA-F]{40}$/.test(param)) {
      return this.sendJson(res, 400, {
        error: 'public_key must be a valid Ethereum address (0x followed by 40 hex characters)',
      });
    }

    const record = await this.sessionDelegationCache.findByAddress(param);
    if (!record) {
      return this.sendJson(res, 404, { error: 'No delegation record found for this address' });
    }

    return this.sendJson(res, 200, record);
  }
```

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

# ZeroDev bundler RPC — required when the backend submits UserOps using deserializePermissionAccount
# (not needed for the current store/retrieve endpoints, but add now so it's ready)
ZERODEV_RPC=https://rpc.zerodev.app/api/v3/<project-id>/chain/43113
```

---

## File creation order

Implement strictly in this order:

1. `npm install ioredis` (from `onchain-agent/`)
2. Create directory `src/use-cases/interface/output/cache/`
3. Create `src/use-cases/interface/output/cache/sessionDelegation.cache.ts`
4. Create directory `src/adapters/implementations/output/cache/`
5. Create `src/adapters/implementations/output/cache/redis.sessionDelegation.ts`
6. Edit `src/adapters/implementations/input/http/httpServer.ts` — import, schemas, constructor param, CORS block, route dispatches, two handler methods
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
    "serializedSessionKey": "eyJhbGciOiJub25lIn0...",
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

Expected response: the full `DelegationRecord` JSON.

### Inspect Redis directly

```bash
redis-cli get "delegation:0x1234567890123456789012345678901234567890"
```

Expected: the same JSON.

---

## API reference (new endpoints)

### `POST /persistent`

**Auth**: None  
**Body**: `DelegationRecord` (JSON, validated by `DelegationRecordSchema`). The `serializedSessionKey` field is the base64 blob produced by `serializePermissionAccount()` on the frontend — it embeds the session private key and is used by the backend for autonomous UserOp submission via `deserializePermissionAccount()`.  
**Responses**:

| Status | Body |
|--------|------|
| 201 | `{ "address": "0x...", "saved": true }` |
| 400 | `{ "error": "Invalid JSON" }` or `{ "error": "Invalid delegation record", "details": [...] }` |
| 503 | `{ "error": "Session delegation store not available" }` (REDIS_URL not set) |

### `GET /permissions`

**Auth**: None  
**Query**: `public_key=0x{40 hex chars}` (the delegated Ethereum **address**, not the raw compressed public key)  
**Responses**:

| Status | Body |
|--------|------|
| 200 | Full `DelegationRecord` JSON |
| 400 | `{ "error": "public_key query parameter is required" }` or address format error |
| 404 | `{ "error": "No delegation record found for this address" }` |
| 503 | `{ "error": "Session delegation store not available" }` (REDIS_URL not set) |

**Important naming note**: the query parameter is called `public_key` to match the frontend naming convention, but it must receive a 42-char Ethereum **address** (not the 68-char raw compressed public key). The frontend should pass the `address` field from the delegation record, not `publicKey`. The parameter name is intentionally kept as `public_key` for API compatibility.
