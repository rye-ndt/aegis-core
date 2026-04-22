# HTTP-Only Communication Revamp — Backend Plan

## Goal

Remove SSE entirely. Replace with a stateless request/response pattern:

1. BE creates a typed request object → stores in Redis → sends bot button with `?requestId=uuid`
2. FE opens, fetches request from `GET /request/:requestId` (no auth)
3. FE processes, POSTs typed result to `POST /response` (Privy auth)
4. BE dispatches per-type post-processing → sends Telegram message → deletes request from Redis

---

## Shared Types

**New file:** `src/adapters/implementations/input/http/miniAppRequest.types.ts`

Duplicated verbatim in FE at `src/types/miniAppRequest.types.ts`. No cross-repo import.

```typescript
export type RequestType = 'auth' | 'sign' | 'approve';
export type ApproveSubtype = 'session_key' | 'aegis_guard';

// ── Request bodies (BE → Redis → FE) ─────────────────────────────────────

interface BaseRequest {
  requestId: string;     // UUID v4
  requestType: RequestType;
  createdAt: number;     // epoch seconds
  expiresAt: number;     // epoch seconds; createdAt + 600
}

export interface AuthRequest extends BaseRequest {
  requestType: 'auth';
  telegramChatId: string;
}

export interface SignRequest extends BaseRequest {
  requestType: 'sign';
  userId: string;
  to: string;            // 0x address
  value: string;         // wei as decimal string
  data: string;          // 0x calldata
  description: string;
  autoSign: boolean;
}

export interface ApproveRequest extends BaseRequest {
  requestType: 'approve';
  userId: string;
  subtype: ApproveSubtype;
  // aegis_guard only — portfolio fetched by FE, but suggested list helps pre-populate the modal
  suggestedTokens?: Array<{ address: string; symbol: string; decimals: number }>;
}

export type MiniAppRequest = AuthRequest | SignRequest | ApproveRequest;

// ── Response bodies (FE → BE) ─────────────────────────────────────────────

interface BaseResponse {
  requestId: string;
  requestType: RequestType;
  privyToken: string;    // Privy JWT — used for auth on POST /response
}

export interface AuthResponse extends BaseResponse {
  requestType: 'auth';
  telegramChatId: string;
}

export interface SignResponse extends BaseResponse {
  requestType: 'sign';
  txHash?: string;
  rejected?: boolean;
}

export interface DelegationRecord {
  publicKey: string;
  address: `0x${string}`;
  smartAccountAddress: `0x${string}`;
  signerAddress: `0x${string}`;
  permissions: unknown[];   // existing Permission[] type from sessionDelegation
  grantedAt: number;
}

export interface AegisGrant {
  sessionKeyAddress: string;
  smartAccountAddress: string;
  tokens: Array<{ address: string; limit: string; validUntil: number }>;
}

export interface ApproveResponse extends BaseResponse {
  requestType: 'approve';
  subtype: ApproveSubtype;
  delegationRecord?: DelegationRecord;   // present when subtype = 'session_key'
  aegisGrant?: AegisGrant;               // present when subtype = 'aegis_guard'
  rejected?: boolean;
}

export type MiniAppResponse = AuthResponse | SignResponse | ApproveResponse;
```

---

## Redis

### New key

`mini_app_req:{requestId}` — JSON `MiniAppRequest`, TTL 600 s

Replaces `sign_req:{id}` for the delivery channel (the internal signing-request resolve mechanism in `ISigningRequestCache` is separate and untouched).

### New interface

**New file:** `src/use-cases/interface/output/cache/miniAppRequest.cache.ts`

```typescript
import type { MiniAppRequest } from '../../...'; // relative path to types file

export interface IMiniAppRequestCache {
  store(request: MiniAppRequest): Promise<void>;
  retrieve(requestId: string): Promise<MiniAppRequest | null>;
  delete(requestId: string): Promise<void>;
}
```

### New implementation

**New file:** `src/adapters/implementations/output/cache/redis.miniAppRequest.ts`

- `store`: `SET mini_app_req:{requestId} JSON.stringify(request) EX 600`
- `retrieve`: `GET` → `JSON.parse`, return `null` if missing
- `delete`: `DEL mini_app_req:{requestId}`

---

## New HTTP Endpoints

Add both to `httpServer.ts` routing block.

### GET /request/:requestId (no auth)

Route match: `method === 'GET' && /^\/request\/([^/]+)$/.test(url.pathname)`

```
1. Extract requestId from path match group
2. miniAppRequestCache.retrieve(requestId) — 404 { error: 'Not found' } if null
3. Check request.expiresAt > newCurrentUTCEpoch() — 410 { error: 'Expired' } if stale
4. Return 200 request
```

No auth. The UUID (122 bits entropy) is the access credential. Only reachable by someone who received the bot button.

### POST /response (Privy auth)

Route match: `method === 'POST' && url.pathname === '/response'`

```
1. readJson(req) → body
2. Zod-parse body as MiniAppResponse (discriminated union on requestType)
3. authUseCase.resolveUserId(body.privyToken) → userId; 401 if null
4. miniAppRequestCache.retrieve(body.requestId) → request; 404 if null
5. For requestType !== 'auth': assert request.userId === userId; 403 if mismatch
6. Dispatch to per-type private handler (see below)
7. On success: miniAppRequestCache.delete(body.requestId)
8. Return 200 { requestId: body.requestId, ok: true }
```

#### handleAuthMiniAppResponse(body: AuthResponse, res)

```
1. authUseCase.loginWithPrivy({ privyToken: body.privyToken, telegramChatId: body.telegramChatId })
2. Parse chatId = parseInt(body.telegramChatId)
3. botRef.api.sendMessage(chatId, "You're signed in. Try asking me anything.")
4. Check userProfileRepo.findByUserId(userId) — if no session key:
   a. Create ApproveRequest { requestType: 'approve', subtype: 'session_key', userId, ... }
   b. miniAppRequestCache.store(approveRequest)
   c. botRef.api.sendMessage(chatId, "Set up your session key to start transacting.", {
        reply_markup: new InlineKeyboard().webApp("Set up session key", `${MINI_APP_URL}?requestId=...`)
      })
```

Step 4 chains auth → session key setup automatically without requiring another user-initiated command.

#### handleSignMiniAppResponse(body: SignResponse, userId, res)

```
1. signingRequestUseCase.resolveRequest({
     requestId: body.requestId,
     userId,
     txHash: body.txHash,
     rejected: body.rejected,
   })
   (This resolves the in-memory promise in the agent tool, unblocking intent execution.)
```

No additional Telegram message needed here — the agent flow sends its own result message once unblocked.

#### handleApproveMiniAppResponse(body: ApproveResponse, userId, res)

For `subtype === 'session_key'` and `body.delegationRecord` present:
```
1. sessionDelegationUseCase.save(body.delegationRecord)
2. Upsert user_profiles:
   - existing = userProfileRepo.findByUserId(userId)
   - if not existing: userProfileRepo.upsert({ userId, smartAccountAddress, eoaAddress: signerAddress, ... })
   - if existing: userProfileRepo.update({ ...existing, smartAccountAddress, eoaAddress })
3. botRef.api.sendMessage(chatId, "Session key installed. You can now execute transactions.")
```

For `subtype === 'aegis_guard'` and `body.aegisGrant` present:
```
1. aegisGuardCache.setGrant(userId, body.aegisGrant)
2. userPreferenceRepo.upsert({ userId, aegisGuardEnabled: true })
3. Look up chatId from telegramSessionRepo.findByUserId(userId)
4. botRef.api.sendMessage(chatId, "Aegis Guard enabled.")
```

For `body.rejected === true`:
```
1. Look up chatId
2. botRef.api.sendMessage(chatId, "Setup cancelled.")
```

Note: `chatId` lookup in approve/sign handlers goes through `telegramSessionRepo.findByUserId(userId)`.

---

## Changes to TelegramBot handler.ts

### sendMiniAppButton — full replacement

Current signature: `sendMiniAppButton(ctx, requestId?, isAutoSign?)`
Current behavior: appends query params, pushes via SSE.

New behavior: creates the `SignRequest`, stores in Redis, sends button with only `?requestId`.

```typescript
private async sendMiniAppButton(
  ctx: CtxLike,
  userId: string,
  params: {
    to: string;
    value: string;
    data: string;
    description: string;
    autoSign: boolean;
  },
): Promise<void> {
  const miniAppUrlBase = process.env.MINI_APP_URL;
  if (!miniAppUrlBase) return;

  const now = newCurrentUTCEpoch();
  const request: SignRequest = {
    requestId: newUuid(),
    requestType: 'sign',
    userId,
    ...params,
    createdAt: now,
    expiresAt: now + 600,
  };
  await this.miniAppRequestCache.store(request);

  const url = `${miniAppUrlBase}?requestId=${request.requestId}`;
  const buttonText = params.autoSign ? 'Execute Automatically' : 'Open Aegis to Sign';
  const promptText = params.autoSign
    ? 'Tap below to execute silently.'
    : 'Tap below to review and sign.';
  await ctx.reply(promptText, { reply_markup: new InlineKeyboard().webApp(buttonText, url) });
}
```

Callers that previously passed `requestId` and `isAutoSign` now pass the full transaction params instead.

### sendWelcomeWithLoginButton — refactor

```typescript
private async sendWelcomeWithLoginButton(chatId: number): Promise<void> {
  const miniAppUrlBase = process.env.MINI_APP_URL;
  if (!miniAppUrlBase) {
    await this.botRef!.api.sendMessage(chatId, 'Welcome to Aegis.');
    return;
  }
  const now = newCurrentUTCEpoch();
  const request: AuthRequest = {
    requestId: newUuid(),
    requestType: 'auth',
    telegramChatId: String(chatId),
    createdAt: now,
    expiresAt: now + 600,
  };
  await this.miniAppRequestCache.store(request);
  const url = `${miniAppUrlBase}?requestId=${request.requestId}`;
  await this.botRef!.api.sendMessage(
    chatId,
    'Welcome to Aegis. Sign in to get started.',
    { reply_markup: new InlineKeyboard().webApp('Open Aegis', url) },
  );
}
```

### sendApproveButton — new helper

Called when session key setup or Aegis Guard setup is needed (e.g., after auth confirms no session key, or in response to a user command).

```typescript
private async sendApproveButton(
  chatId: number,
  userId: string,
  subtype: ApproveSubtype,
  promptText: string,
  buttonText: string,
): Promise<void> {
  const miniAppUrlBase = process.env.MINI_APP_URL;
  if (!miniAppUrlBase) return;
  const now = newCurrentUTCEpoch();
  const request: ApproveRequest = {
    requestId: newUuid(),
    requestType: 'approve',
    userId,
    subtype,
    createdAt: now,
    expiresAt: now + 600,
  };
  await this.miniAppRequestCache.store(request);
  const url = `${miniAppUrlBase}?requestId=${request.requestId}`;
  await ctx.reply(promptText, { reply_markup: new InlineKeyboard().webApp(buttonText, url) });
}
```

---

## Dependency Injection (assistant.di.ts)

- **Add** `miniAppRequestCache: IMiniAppRequestCache` — wire `RedisMiniAppRequestCache`
- **Pass** to `HttpApiServer` constructor and `TelegramAssistantHandler` constructor
- **Remove** `sseRegistry: ISseRegistry` from wiring and constructor calls
- **Keep** `signingRequestCache` and `signingRequestUseCase` — `resolveRequest` still needed

---

## ISigningRequestUseCase — Trimmed Interface

Remove methods that are no longer needed (delivery is now handled by Telegram handler + miniAppRequestCache):

**Remove from interface and implementation:**
- `createRequest` — creation now done directly in Telegram handler using `miniAppRequestCache`
- `getPendingForUser` — was only used for SSE replay in `handleGetEvents`
- `getRequest` — retrieval now done via `GET /request/:requestId` using `miniAppRequestCache`

**Keep:**
- `resolveRequest` — called by `handleSignMiniAppResponse`; resolves in-memory promise that unblocks the agent tool

**ISigningRequestCache** — also trim:
- Remove `findPendingByUserId` (only used for SSE replay)
- Keep: `save`, `findById`, `resolve` (used internally by `SigningRequestUseCase.resolveRequest`)

---

## Remove

### Endpoints in httpServer.ts

| Endpoint | Reason |
|---|---|
| `GET /events` (`handleGetEvents`) | SSE gone |
| `POST /sign-response` (`handlePostSignResponse`) | Replaced by `POST /response` sign handler |
| `POST /persistent` (`handlePostPersistent`) | Replaced by `POST /response` approve handler |

### Infrastructure files (delete entirely)

| File | Reason |
|---|---|
| `src/use-cases/interface/output/sse/sseRegistry.interface.ts` | SSE gone |
| `src/adapters/implementations/output/sse/sseRegistry.ts` | SSE gone |

### Redis keys (stop writing, no migration needed — TTL will expire them)

- `sign_req:{id}` — replaced by `mini_app_req:{id}` for delivery
- `sign_req:pending:{userId}` — was only for SSE replay

---

## File Summary

### New

| File | Purpose |
|---|---|
| `src/adapters/implementations/input/http/miniAppRequest.types.ts` | Shared request/response type definitions |
| `src/use-cases/interface/output/cache/miniAppRequest.cache.ts` | `IMiniAppRequestCache` interface |
| `src/adapters/implementations/output/cache/redis.miniAppRequest.ts` | Redis implementation |

### Modified

| File | Changes |
|---|---|
| `src/adapters/implementations/input/http/httpServer.ts` | Add `GET /request/:id`, `POST /response`; remove `GET /events`, `POST /sign-response`, `POST /persistent` |
| `src/adapters/implementations/input/telegram/handler.ts` | Refactor `sendMiniAppButton`, `sendWelcomeWithLoginButton`; add `sendApproveButton`; inject `miniAppRequestCache` |
| `src/adapters/inject/assistant.di.ts` | Swap SSE registry for `miniAppRequestCache`; wire to both `HttpApiServer` and `TelegramAssistantHandler` |
| `src/use-cases/interface/input/signingRequest.interface.ts` | Remove `createRequest`, `getPendingForUser`, `getRequest` |
| `src/use-cases/interface/output/cache/signingRequest.cache.ts` | Remove `findPendingByUserId` |
| `src/use-cases/implementations/signingRequest.ts` | Remove methods trimmed from interface |

### Deleted

| File |
|---|
| `src/use-cases/interface/output/sse/sseRegistry.interface.ts` |
| `src/adapters/implementations/output/sse/sseRegistry.ts` |
