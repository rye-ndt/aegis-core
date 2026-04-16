# BE — Telegram Login Support

**Goal:** When the Mini App performs Telegram auto-login via Privy and calls `POST /auth/privy`,
the backend should simultaneously link the caller's Telegram `chatId` to their `userId` —
so the bot's commands (`/confirm`, `/portfolio`, etc.) work immediately, with no `/auth <token>`
step required.

**Approach:** Extend `POST /auth/privy` to accept an optional `telegramChatId` field.
One endpoint, one call, one transaction. No new routes, no new interfaces.

---

## Context & Constraints

| Item | Current state |
|---|---|
| `POST /auth/privy` body | `{ token: string }` |
| `POST /auth/privy` response | `{ token, expiresAtEpoch, userId }` |
| Session link table | `telegram_sessions`: `telegramChatId → userId + expiresAtEpoch` |
| `ITelegramSessionDB.upsert` | Already exists and works |
| Bot's `/auth` command | Calls the same `authUseCase.loginWithPrivy({ privyToken })` — must keep working |

---

## Guardrails

1. `telegramChatId` is **optional**. If absent, the endpoint behaves exactly as before.
   The bot's `/auth <token>` command does not send a `chatId` and must not break.
2. Validate that `telegramChatId` is a numeric string if provided. Reject with 400 otherwise.
3. Do not add `telegramChatId` to the `IAuthUseCase` interface method signature in a way that
   breaks existing callers. Use an optional field on the input type.
4. No schema changes — `telegram_sessions` already has the right shape.
5. Run `tsc --noEmit` after each step. Zero errors before moving to the next step.

---

## Step 1 — Extend `IPrivyLoginInput` in the auth interface

**File:** `src/use-cases/interface/input/auth.interface.ts`

```diff
 export interface IPrivyLoginInput {
   privyToken: string;
+  telegramChatId?: string;   // optional — link session during login
 }
```

No other changes to the interface. The method signature `loginWithPrivy(input: IPrivyLoginInput)`
stays identical.

**Verification:** `tsc --noEmit` passes.

---

## Step 2 — Implement the session link in `AuthUseCaseImpl`

**File:** `src/use-cases/implementations/auth.usecase.ts`

Inject `ITelegramSessionDB` into the constructor (it is not there yet), then use it inside
`loginWithPrivy` when `telegramChatId` is provided.

```diff
+import type { ITelegramSessionDB } from '../interface/output/repository/telegramSession.repo';

 export class AuthUseCaseImpl implements IAuthUseCase {
   constructor(
     private readonly userDB: IUserDB,
     private readonly jwtSecret: string,
     private readonly jwtExpiresIn: string,
     private readonly privyAuthService?: IPrivyAuthService,
+    private readonly telegramSessionDB?: ITelegramSessionDB,
   ) {}

   async loginWithPrivy(input: IPrivyLoginInput): Promise<{ token: string; expiresAtEpoch: number; userId: string }> {
     if (!this.privyAuthService) throw new Error('PRIVY_NOT_CONFIGURED');

     const { privyDid, email } = await this.privyAuthService.verifyToken(input.privyToken);

     let user = await this.userDB.findByPrivyDid(privyDid);
     if (!user) {
       // ... existing user creation logic, unchanged ...
     }

     const result = this.issueJwt(user.id, user.email);

+    // If a Telegram chatId was provided, link it now in the same call.
+    if (input.telegramChatId && this.telegramSessionDB) {
+      await this.telegramSessionDB.upsert({
+        telegramChatId: input.telegramChatId,
+        userId: user.id,
+        expiresAtEpoch: result.expiresAtEpoch,
+      });
+    }

     return result;
   }
 }
```

**Guardrail:** Check the exact field names of `ITelegramSessionDB.upsert`'s input type before
writing — confirm `createdAtEpoch` is handled by the repo or add it if required. Do not guess.

**Verification:** `tsc --noEmit` passes.

---

## Step 3 — Accept `telegramChatId` in the HTTP handler

**File:** `src/adapters/implementations/input/http/httpServer.ts`

Extend the Zod schema and pass the field through.

```diff
 const parsed = z.object({
   privyToken: z.string().min(1),
+  telegramChatId: z.string().regex(/^\d+$/).optional(),
 }).safeParse(body);

 // ...

 const result = await this.authUseCase.loginWithPrivy({
   privyToken: parsed.data.privyToken,
+  telegramChatId: parsed.data.telegramChatId,
 });
```

Nothing else in this file changes.

**Verification:** `tsc --noEmit` passes.

---

## Step 4 — Wire `ITelegramSessionDB` into `AuthUseCaseImpl` in the DI container

**File:** `src/adapters/inject/assistant.di.ts`

Find where `AuthUseCaseImpl` is instantiated and pass the telegram session repo as the new
fifth argument.

```diff
 new AuthUseCaseImpl(
   db.users,
   jwtSecret,
   jwtExpiresIn,
   privyAuthService,
+  db.telegramSessions,
 )
```

**Guardrail:** Confirm the property name on the `DrizzleSqlDB` instance (likely `telegramSessions`).
Check `drizzleSqlDb.adapter.ts` to be sure before writing.

**Verification:** `tsc --noEmit` passes. `npm run build` is clean.

---

## Step 5 — Update the FE call site

> Cross-reference: this change lives in the FE codebase but is documented here for completeness.

In `src/App.tsx` → `usePrivySession`, extend the existing `POST /auth/privy` call:

```diff
 body: JSON.stringify({
   token: privyToken,
+  ...(window.Telegram?.WebApp?.initDataUnsafe?.user?.id
+    ? { telegramChatId: String(window.Telegram.WebApp.initDataUnsafe.user.id) }
+    : {}),
 }),
```

Only runs inside Telegram (the spread is empty otherwise). No second HTTP call needed.

---

## Step 6 — (Optional cleanup) Add a comment to the `web_app_data` bot handler

**File:** `src/adapters/implementations/input/telegram/handler.ts`

The handler at `bot.on("message:web_app_data", ...)` is now dead code in the new flow.
Do NOT remove it — keep it as a fallback for older Mini App clients. Add a comment:

```typescript
// NOTE: Superseded by the optional telegramChatId field in POST /auth/privy.
// Kept for backward compatibility with Mini App versions that still call sendData.
bot.on("message:web_app_data", async (ctx) => {
```

---

## End-to-end verification checklist

- [ ] `tsc --noEmit` passes with zero errors.
- [ ] `npm run build` succeeds.
- [ ] `POST /auth/privy { token }` (no chatId) still works — regression check for bot `/auth` command.
- [ ] `POST /auth/privy { token, telegramChatId: "abc" }` returns 400 (non-numeric chatId).
- [ ] `POST /auth/privy { token, telegramChatId: "123456789" }` returns 200 and a row appears
      in `telegram_sessions`.
- [ ] After the above, user can send `/portfolio` to the bot without running `/auth`.
- [ ] `context.md` updated.

---

## Files touched

| File | Action |
|---|---|
| `src/use-cases/interface/input/auth.interface.ts` | Add optional `telegramChatId` to `IPrivyLoginInput` |
| `src/use-cases/implementations/auth.usecase.ts` | Inject `ITelegramSessionDB`; upsert session if chatId present |
| `src/adapters/implementations/input/http/httpServer.ts` | Accept + pass through `telegramChatId` in Zod schema |
| `src/adapters/inject/assistant.di.ts` | Pass `db.telegramSessions` to `AuthUseCaseImpl` |
| `src/adapters/implementations/input/telegram/handler.ts` | Add backward-compat comment only |

## Files NOT touched

Everything else — no new endpoints, no new interfaces, no schema changes, no migrations.
