# Mini-App Signing Flow — Backend

## Goal

After the Telegram handler finishes forming calldata (`buildAndShowConfirmation` /
`buildAndShowConfirmationFromResolved`), the bot should automatically:

1. Push a `sign_request` SSE event to the frontend (already-connected users get it instantly)
2. Send a Telegram message with an inline WebApp button so the user can open Aegis if they aren't already
3. Replay the pending signing request the moment the mini app establishes the SSE connection (handles the case where the app opens after the push)

The frontend then signs and POSTs back via `POST /sign-response`. The existing
`onResolved` callback in `telegramCli.ts` sends a confirmation message.

---

## Gap Analysis (current state)

| # | File | Missing |
|---|------|---------|
| 1 | `handler.ts` — `buildAndShowConfirmation` + `buildAndShowConfirmationFromResolved` | Never calls `signingRequestUseCase.createRequest()` |
| 2 | `handler.ts` — confirmation messages | Still say "Type /confirm to execute" instead of directing to app |
| 3 | `handler.ts` | No Telegram inline WebApp button sent after calldata is ready |
| 4 | `httpServer.ts` — `handleGetEvents` | Does not replay pending signing request on SSE connect |
| 5 | `signingRequest.cache.ts` | No `findPendingByUserId` method |
| 6 | `redis.signingRequest.ts` | No `findPendingByUserId` implementation |
| 7 | `signingRequest.interface.ts` | No `getPendingForUser` method |
| 8 | `signingRequest.usecase.ts` | No `getPendingForUser` implementation |
| 9 | `assistant.di.ts` — `getHttpApiServer` | Does not pass `signingRequestUseCase` to `HttpApiServer` for replay |

---

## Step-by-Step Implementation

### Step 1 — `src/use-cases/interface/output/cache/signingRequest.cache.ts`

Add `findPendingByUserId` to `ISigningRequestCache`:

```typescript
export interface ISigningRequestCache {
  save(record: SigningRequestRecord): Promise<void>;
  findById(id: string): Promise<SigningRequestRecord | null>;
  resolve(id: string, status: 'approved' | 'rejected', txHash?: string): Promise<void>;
  // NEW
  findPendingByUserId(userId: string): Promise<SigningRequestRecord | null>;
}
```

---

### Step 2 — `src/adapters/implementations/output/cache/redis.signingRequest.ts`

Add a secondary index key `sign_req:pending:{userId}` → `requestId`.

```typescript
private pendingKey(userId: string): string {
  return `sign_req:pending:${userId}`;
}

async save(record: SigningRequestRecord): Promise<void> {
  const ttl = Math.max(10, record.expiresAt - Math.floor(Date.now() / 1000));
  const pipeline = this.redis.pipeline();
  pipeline.set(this.key(record.id), JSON.stringify(record), 'EX', ttl);
  pipeline.set(this.pendingKey(record.userId), record.id, 'EX', ttl);
  await pipeline.exec();
}

async resolve(id: string, status: 'approved' | 'rejected', txHash?: string): Promise<void> {
  const record = await this.findById(id);
  if (!record) return;
  const pipeline = this.redis.pipeline();
  pipeline.set(this.key(id), JSON.stringify({ ...record, status, txHash }), 'KEEPTTL');
  // Only delete the pending pointer if it still points at this request
  // (protects against a newer request overwriting the pointer before this one resolves)
  pipeline.eval(
    `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
    1,
    this.pendingKey(record.userId),
    id,
  );
  await pipeline.exec();
}

async findPendingByUserId(userId: string): Promise<SigningRequestRecord | null> {
  const id = await this.redis.get(this.pendingKey(userId));
  if (!id) return null;
  const record = await this.findById(id);
  // Guard: only return if still pending (not yet resolved)
  if (!record || record.status !== 'pending') return null;
  return record;
}
```

---

### Step 3 — `src/use-cases/interface/input/signingRequest.interface.ts`

Add `getPendingForUser` to `ISigningRequestUseCase`:

```typescript
export interface ISigningRequestUseCase {
  createRequest(params: { ... }): Promise<{ requestId: string; pushed: boolean }>;
  resolveRequest(params: { ... }): Promise<void>;
  // NEW
  getPendingForUser(userId: string): Promise<{
    requestId: string;
    to: string;
    value: string;
    data: string;
    description: string;
    expiresAt: number;
  } | null>;
}
```

---

### Step 4 — `src/use-cases/implementations/signingRequest.usecase.ts`

Implement `getPendingForUser`:

```typescript
async getPendingForUser(userId: string) {
  const record = await this.cache.findPendingByUserId(userId);
  if (!record) return null;
  return {
    requestId: record.id,
    to: record.to,
    value: record.value,
    data: record.data,
    description: record.description,
    expiresAt: record.expiresAt,
  };
}
```

---

### Step 5 — `src/adapters/implementations/input/http/httpServer.ts`

In `handleGetEvents`, after `this.sseRegistry.connect(userId, res)`, replay any pending request:

```typescript
private handleGetEvents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  // ... existing auth + SSE header setup ...

  this.sseRegistry.connect(userId, res);

  // Replay: push any pending signing request the user may have missed
  // (covers the case where the mini app opens after the bot already pushed the event)
  if (this.signingRequestUseCase) {
    this.signingRequestUseCase.getPendingForUser(userId).then((pending) => {
      if (!pending) return;
      const now = Math.floor(Date.now() / 1000);
      if (pending.expiresAt <= now) return; // already expired, skip
      this.sseRegistry!.push(userId, {
        type: 'sign_request',
        requestId: pending.requestId,
        to: pending.to,
        value: pending.value,
        data: pending.data,
        description: pending.description,
        expiresAt: pending.expiresAt,
      });
    }).catch((err) => {
      console.error('[SSE] replay pending signing request failed:', err);
    });
  }
}
```

No constructor change needed — `signingRequestUseCase` is already a constructor parameter.

---

### Step 6 — `src/adapters/implementations/input/telegram/handler.ts`

**6a. In `buildAndShowConfirmation`** — after building calldata, before `safeSend`:

```typescript
// Create signing request → SSE push to frontend
if (this.signingRequestUseCase) {
  await this.signingRequestUseCase.createRequest({
    userId,
    chatId,
    to: calldata.to,
    value: calldata.value,
    data: calldata.data,
    description: session.manifest.name,
  });
}

// Show calldata preview
await this.safeSend(ctx, this.buildConfirmationMessage(session, calldata, resolvedFrom, resolvedTo));

// Send WebApp button to open mini app
await this.sendMiniAppButton(ctx);
```

**6b. In `buildAndShowConfirmationFromResolved`** — same change, same location (after calldata is built, before `safeSend`):

```typescript
if (this.signingRequestUseCase) {
  await this.signingRequestUseCase.createRequest({
    userId,
    chatId,
    to: calldata.to,
    value: calldata.value,
    data: calldata.data,
    description: session.manifest.name,
  });
}
```

Then after `safeSend(ctx, ...)`, add:
```typescript
await this.sendMiniAppButton(ctx);
```

**6c. Change `buildConfirmationMessage`** — remove the /confirm instruction from the closing line:

```diff
-  lines.push("", "Type /confirm to execute or /cancel to abort.");
+  lines.push("", "Open the Aegis app to review and sign this transaction.");
```

Same change for `buildFinalSchemaConfirmation`.

**6d. Add private helper `sendMiniAppButton`**:

```typescript
private async sendMiniAppButton(
  ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
): Promise<void> {
  const miniAppUrl = process.env.MINI_APP_URL;
  if (!miniAppUrl) return;

  const keyboard = new InlineKeyboard().webApp('Open Aegis to Sign', miniAppUrl);
  await ctx.reply(
    'Tap the button below to review and sign this transaction in Aegis.',
    { reply_markup: keyboard },
  );
}
```

`InlineKeyboard` is already imported at the top of `handler.ts`.

---

### Step 7 — Environment variable

Add `MINI_APP_URL` to the backend env vars:

| Variable | Purpose |
|---|---|
| `MINI_APP_URL` | HTTPS URL of the Aegis mini app (e.g. `https://aegis.example.com`). If absent, the WebApp button is silently skipped. |

Update `status.md` env var table accordingly.

---

## Open Question

**Should `/confirm` still execute the transaction via the backend session key?**

Current risk: the user sees the calldata preview in Telegram AND the signing modal in Aegis — if they both execute, the transaction runs twice.

Proposed mitigation (already in step 6c): remove "Type /confirm to execute" from the message so users are not prompted. The `/confirm` command handler is kept but not advertised. Remove or repurpose once the SSE path is fully validated.

---

## Sequence Diagram (full end-to-end)

```
User                  Telegram Bot              Backend (SSE)          Aegis mini app
  │  (sends intent)       │                          │                      │
  │──────────────────────►│                          │                      │
  │                       │ buildRequestBody()        │                      │
  │                       │ signingRequestUseCase     │                      │
  │                       │   .createRequest()        │                      │
  │                       │──────────────────────────►│                      │
  │                       │   ← { requestId, pushed } │                      │
  │                       │                          │                      │
  │  (preview message)    │                          │                      │
  │◄──────────────────────│                          │                      │
  │  [Open Aegis button]  │                          │                      │
  │◄──────────────────────│                          │                      │
  │                       │                          │                      │
  │ taps button           │                          │                      │
  │──────────────────────────────────────────────────────────────────────►  │
  │                       │                          │  GET /events (SSE)   │
  │                       │                          │◄─────────────────────│
  │                       │                          │  replay pending      │
  │                       │                          │─────────────────────►│
  │                       │                          │  sign_request event  │
  │                       │                          │─────────────────────►│
  │                       │                          │                      │ (modal shown)
  │                       │                          │                      │ user approves
  │                       │                          │  POST /sign-response │
  │                       │                          │◄─────────────────────│
  │                       │                          │  onResolved callback │
  │  "Tx submitted: 0x…"  │                          │                      │
  │◄──────────────────────│                          │                      │
  │                       │                          │                      │ (mini app closes)
```

---

## Files Changed

| File | Change |
|---|---|
| `src/use-cases/interface/output/cache/signingRequest.cache.ts` | Add `findPendingByUserId` |
| `src/adapters/implementations/output/cache/redis.signingRequest.ts` | Implement `findPendingByUserId` with secondary index |
| `src/use-cases/interface/input/signingRequest.interface.ts` | Add `getPendingForUser` |
| `src/use-cases/implementations/signingRequest.usecase.ts` | Implement `getPendingForUser` |
| `src/adapters/implementations/input/http/httpServer.ts` | Replay pending on SSE connect |
| `src/adapters/implementations/input/telegram/handler.ts` | Push signing request + send WebApp button in confirmation flow |
| `status.md` (env vars table) | Add `MINI_APP_URL` |
