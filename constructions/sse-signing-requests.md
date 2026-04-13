# SSE Signing Requests — Backend

## Goal

When the Telegram bot (or any internal caller) needs the user's smart account to execute a transaction, it creates a signing request. The backend:
1. Persists the request in Redis with a TTL
2. Pushes it to the user's connected SSE stream
3. Waits for the frontend to POST back a txHash
4. Sends a Telegram follow-up message confirming the transaction

---

## Architecture

```
TelegramHandler              SigningRequestUseCase         SseRegistry (in-memory)
      │                              │                             │
      │── createRequest(userId,chatId,callData) ─►│              │
      │                              │── save to Redis ────────────│
      │                              │── push SSE event ──────────►│──► browser
      │◄─ requestId ─────────────────│                             │
      │                              │                             │
      │  (browser signs, POSTs txHash)                             │
      │                              │                             │
HttpServer                           │                             │
      │── POST /sign-response ───────►│                            │
      │                              │── update Redis status       │
      │                              │── onResolved callback       │
      │                              │       │                     │
      │                         TelegramBot API                    │
      │                              │── sendMessage(chatId, "tx submitted: 0x...")
```

---

## File Map

| File | Role |
|---|---|
| `src/adapters/implementations/output/sse/sseRegistry.ts` | In-memory map of userId → SSE response; push events; heartbeat |
| `src/adapters/implementations/output/cache/redis.signingRequest.ts` | Redis adapter for signing requests |
| `src/use-cases/interface/output/cache/signingRequest.cache.ts` | Port interface for signing request cache |
| `src/use-cases/interface/input/signingRequest.interface.ts` | Use-case input port |
| `src/use-cases/implementations/signingRequest.usecase.ts` | Orchestrates create → push → resolve → notify |
| `src/adapters/implementations/input/http/httpServer.ts` | **Modified**: add `GET /events`, `POST /sign-response` routes |
| `src/adapters/inject/assistant.di.ts` | **Modified**: wire new classes; pass bot notify callback |
| `src/adapters/implementations/input/telegram/handler.ts` | **Modified**: inject `ISigningRequestUseCase`; add `/transfer` command |

---

## Data Types

```ts
// src/use-cases/interface/output/cache/signingRequest.cache.ts

export type SigningRequestRecord = {
  id: string;                    // UUID
  userId: string;                // backend userId (from JWT)
  chatId: number;                // Telegram chat ID for follow-up notification
  to: string;                    // target address
  value: string;                 // wei as decimal string
  data: string;                  // calldata hex
  description: string;           // human-readable summary
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  txHash?: string;               // set on resolution
  createdAt: number;             // unix timestamp
  expiresAt: number;             // unix timestamp (TTL = 5 min)
};

export interface ISigningRequestCache {
  save(record: SigningRequestRecord): Promise<void>;
  findById(id: string): Promise<SigningRequestRecord | null>;
  resolve(id: string, status: 'approved' | 'rejected', txHash?: string): Promise<void>;
}
```

Redis keys:
- `sign_req:{id}` → JSON, TTL = `expiresAt - now` seconds (min 10s)

---

## Step-by-Step Implementation

### Step 1 — `src/adapters/implementations/output/sse/sseRegistry.ts`

```ts
import http from 'node:http';

export class SseRegistry {
  private connections = new Map<string, http.ServerResponse>();
  private heartbeatTimer: NodeJS.Timeout;

  constructor(heartbeatIntervalMs = 25_000) {
    // Send a comment ping every 25s to keep connections alive through proxies/Telegram WebView
    this.heartbeatTimer = setInterval(() => {
      for (const [userId, res] of this.connections) {
        try {
          res.write(': ping\n\n');
        } catch {
          this.connections.delete(userId);
        }
      }
    }, heartbeatIntervalMs);
  }

  connect(userId: string, res: http.ServerResponse): void {
    // Close any existing connection for this user (re-connect scenario)
    this.connections.get(userId)?.end();
    this.connections.set(userId, res);
    res.on('close', () => this.connections.delete(userId));
  }

  push(userId: string, event: { type: string; [key: string]: unknown }): boolean {
    const res = this.connections.get(userId);
    if (!res) return false;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      return true;
    } catch {
      this.connections.delete(userId);
      return false;
    }
  }

  isConnected(userId: string): boolean {
    return this.connections.has(userId);
  }

  stop(): void {
    clearInterval(this.heartbeatTimer);
    for (const res of this.connections.values()) {
      try { res.end(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }
}
```

---

### Step 2 — `src/adapters/implementations/output/cache/redis.signingRequest.ts`

```ts
import Redis from 'ioredis';
import type { ISigningRequestCache, SigningRequestRecord } from '...';

export class RedisSigningRequestCache implements ISigningRequestCache {
  constructor(private readonly redis: Redis) {}

  private key(id: string) { return `sign_req:${id}`; }

  async save(record: SigningRequestRecord): Promise<void> {
    const ttl = Math.max(10, record.expiresAt - Math.floor(Date.now() / 1000));
    await this.redis.set(this.key(record.id), JSON.stringify(record), 'EX', ttl);
  }

  async findById(id: string): Promise<SigningRequestRecord | null> {
    const raw = await this.redis.get(this.key(id));
    return raw ? JSON.parse(raw) : null;
  }

  async resolve(id: string, status: 'approved' | 'rejected', txHash?: string): Promise<void> {
    const record = await this.findById(id);
    if (!record) return;
    await this.redis.set(
      this.key(id),
      JSON.stringify({ ...record, status, txHash }),
      'KEEPTTL',
    );
  }
}
```

**Share the Redis connection** — do not create a second `ioredis` client. The existing `RedisSessionDelegationCache` holds a `Redis` instance. In `AssistantInject`, extract the Redis client into a shared getter and pass it to both caches.

---

### Step 3 — `src/use-cases/implementations/signingRequest.usecase.ts`

```ts
export interface ISigningRequestUseCase {
  createRequest(params: {
    userId: string;
    chatId: number;
    to: string;
    value: string;     // wei decimal string
    data: string;      // calldata hex
    description: string;
  }): Promise<{ requestId: string; pushed: boolean }>;

  resolveRequest(params: {
    requestId: string;
    userId: string;    // must match record.userId
    txHash?: string;
    rejected?: boolean;
  }): Promise<void>;
}
```

`createRequest` implementation:
1. Generate UUID `id`
2. Build `SigningRequestRecord` with `expiresAt = now + 300` (5 min)
3. `cache.save(record)`
4. `pushed = sseRegistry.push(userId, { type: 'sign_request', requestId: id, to, value, data, description, expiresAt })`
5. Return `{ requestId: id, pushed }`

`resolveRequest` implementation:
1. `record = cache.findById(requestId)` — throw if not found or `record.userId !== userId`
2. Check `record.expiresAt > now` — throw `SIGNING_REQUEST_EXPIRED` if not
3. `cache.resolve(requestId, rejected ? 'rejected' : 'approved', txHash)`
4. Call `onResolved(record.chatId, txHash, rejected)` callback

`onResolved` callback is injected at construction time by the DI layer:

```ts
constructor(
  private readonly cache: ISigningRequestCache,
  private readonly sseRegistry: SseRegistry,
  private readonly onResolved: (chatId: number, txHash: string | undefined, rejected: boolean) => void,
) {}
```

---

### Step 4 — Modify `httpServer.ts`

Add two routes:

**`GET /events`**
```
Authorization: Bearer <jwt>  (or ?token=<jwt> if Authorization header not present)
```

- Extract userId (try header first, then `?token` query param — EventSource can't set headers)
- Set SSE headers:
  ```
  Content-Type: text/event-stream
  Cache-Control: no-cache
  Connection: keep-alive
  X-Accel-Buffering: no   // disable nginx buffering if behind a proxy
  ```
- Call `sseRegistry.connect(userId, res)`
- Do NOT call `res.end()` — connection stays open until client disconnects

**`POST /sign-response`**

Body: `{ requestId: string; txHash?: string; rejected?: boolean }`

- Extract userId (header JWT — required)
- Validate body with Zod
- Call `signingRequestUseCase.resolveRequest({ requestId, userId, txHash, rejected })`
- Respond `200 { requestId, resolved: true }`
- Error `404` if request not found, `410` if expired, `403` if userId mismatch

Add `SseRegistry` and `ISigningRequestUseCase` to `HttpApiServer` constructor as optional params (consistent with existing pattern).

---

### Step 5 — Modify `TelegramAssistantHandler`

Inject `ISigningRequestUseCase` as an optional constructor param.

Add a `/sign` command (or trigger from intent parsing) for testing:

```
/sign <to> <value_in_ether> <calldata> <description>
```

Or a higher-level `/transfer` command that calls an intent parser and creates a signing request:

```
/transfer 0.1 AVAX to 0xABC...
```

For the bot notification when a request resolves, the DI wires a callback:

```ts
async function notifyResolved(chatId: number, txHash: string | undefined, rejected: boolean): Promise<void> {
  if (rejected) {
    await bot.api.sendMessage(chatId, 'Transaction rejected in the app.');
  } else {
    await bot.api.sendMessage(chatId, `Transaction submitted.\nTx hash: \`${txHash}\``, { parse_mode: 'Markdown' });
  }
}
```

This callback is created in `telegramCli.ts` after the bot instance is created, then passed to `AssistantInject.getSigningRequestUseCase(notifyResolved)`.

---

### Step 6 — Modify `AssistantInject`

Add a shared Redis client getter so both `RedisSessionDelegationCache` and `RedisSigningRequestCache` share one connection:

```ts
private _redis: Redis | null = null;

getRedis(): Redis | undefined {
  const url = process.env.REDIS_URL;
  if (!url) return undefined;
  if (!this._redis) {
    this._redis = new Redis(url, { lazyConnect: false });
    this._redis.on('error', (err) => console.error('[Redis]', err.message));
  }
  return this._redis;
}
```

Update `getSessionDelegationCache()` to use `getRedis()` instead of constructing its own client.

Add:

```ts
private _sseRegistry: SseRegistry | null = null;
private _signingRequestUseCase: ISigningRequestUseCase | null = null;

getSseRegistry(): SseRegistry {
  if (!this._sseRegistry) this._sseRegistry = new SseRegistry();
  return this._sseRegistry;
}

getSigningRequestUseCase(
  onResolved: (chatId: number, txHash: string | undefined, rejected: boolean) => void,
): ISigningRequestUseCase | undefined {
  const redis = this.getRedis();
  if (!redis) return undefined;
  if (!this._signingRequestUseCase) {
    this._signingRequestUseCase = new SigningRequestUseCaseImpl(
      new RedisSigningRequestCache(redis),
      this.getSseRegistry(),
      onResolved,
    );
  }
  return this._signingRequestUseCase;
}
```

Update `getHttpApiServer()` to pass `getSseRegistry()` and `getSigningRequestUseCase(...)`.

Update `telegramCli.ts`:
- Create `bot` instance before `inject`
- Wire `notifyResolved` using `bot.api.sendMessage`
- Pass to `inject.getSigningRequestUseCase(notifyResolved)`

---

### Step 7 — Shutdown

In `telegramCli.ts` SIGINT handler, add:
```ts
inject.getSseRegistry().stop();
```

---

## Env vars (no new ones required)

`REDIS_URL` — already required for session delegation.

---

## Decisions

1. **JWT via query param**: EventSource can't set `Authorization` header. Backend accepts `?token=<jwt>` as fallback when `Authorization` header is absent.
2. **One SSE connection per user**: If a user opens a second tab, the new connection replaces the old one. The old `res` is ended cleanly.
3. **Shared Redis client**: One `ioredis` instance, shared between `RedisSessionDelegationCache` and `RedisSigningRequestCache`. Fewer TCP connections, simpler cleanup.
4. **onResolved callback**: Keeps `SigningRequestUseCaseImpl` decoupled from grammy. The DI layer wires the Telegram notification at startup.
5. **Request expiry**: Handled at `resolveRequest` time (backend checks TTL). Redis TTL is also set so expired keys self-delete.
6. **`POST /sign-request` (external API)**: Not included in this plan — the bot creates requests internally via the use case. Add a protected `POST /sign-request` endpoint later if external callers need it.

---

## Out of Scope

- Queuing requests when the frontend is offline (future: persist and push on reconnect)
- Multiple pending requests per user (future)
- Idempotency keys for sign-response retries
