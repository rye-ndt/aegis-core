# Session Delegation — Backend Implementation Plan (Part 1 of 2)

> Date: 2026-04-11  
> Status: Draft (v3 — client-side signing; backend stores public metadata only)  
> Touches: `httpServer.ts`, new port + adapter files  
> **See Part 2 for**: DI wiring (`assistant.di.ts`), `.env.example`, verification, API reference

---

## Goal

Add two new HTTP endpoints that persist and retrieve session key delegation records:

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| `POST` | `/persistent` | None | Store a delegation record (public key + address + permissions) in Redis |
| `GET` | `/permissions?public_key=0x...` | None | Retrieve the stored delegation record for a given Ethereum address |

No JWT auth on these endpoints. They are called by the Telegram Mini App frontend during onboarding, before the user has a server-side JWT.

**The backend never sees any private key material.** The session key private key is encrypted and stored in Telegram CloudStorage exclusively on the client. The serialized ZeroDev permission account blob (which embeds the private key) also stays client-side. All UserOp signing and submission happens from the mini app frontend. The backend stores only public metadata needed to verify or query what a given session key is authorized to do.

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
  publicKey: string;             // 0x-prefixed compressed secp256k1 public key
  address: string;               // 0x + 40 hex chars — the session key's Ethereum address
  smartAccountAddress: string;   // User's Privy ERC-4337 Kernel smart account
  signerAddress: string;         // User's Privy embedded wallet (EOA), owns the Kernel account
  permissions: Permission[];
  grantedAt: number;             // Unix epoch seconds
  // No serializedSessionKey — private key material never leaves the client
};
```

Redis key: `delegation:{record.address.toLowerCase()}`

### What is NOT stored here

- The session key's private key
- The ZeroDev serialized permission account blob (it contains the private key)
- The user's Privy JWT or any auth token

These all stay encrypted in Telegram CloudStorage on the user's device. The frontend decrypts them locally and signs + submits UserOperations directly to the ZeroDev bundler RPC.

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
    // The frontend should pass the session key `address` field, not the raw compressed public key.
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

## File creation order (Part 1 steps)

Implement strictly in this order:

1. `npm install ioredis` (from `onchain-agent/`)
2. Create directory `src/use-cases/interface/output/cache/`
3. Create `src/use-cases/interface/output/cache/sessionDelegation.cache.ts`
4. Create directory `src/adapters/implementations/output/cache/`
5. Create `src/adapters/implementations/output/cache/redis.sessionDelegation.ts`
6. Edit `src/adapters/implementations/input/http/httpServer.ts` — import, schemas, constructor param, CORS block, route dispatches, two handler methods

**Continue with Part 2** (`session-delegation-plan-part2.md`) for the DI wiring, env update, and verification steps.
