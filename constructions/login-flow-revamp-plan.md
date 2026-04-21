# Login Flow Revamp & Privy User Profile Storage — Backend

> Date: 2026-04-21
> Status: Draft
> Touches: `handler.ts`, `auth.usecase.ts`, `privyAuth.interface.ts`, `privyServer.adapter.ts`, `assistant.di.ts`, new files

---

## Goal

1. After `/logout`, the bot immediately resends the welcome message + login button so the user is never left in a dead end.
2. After a successful `POST /auth/privy` (mini app → backend), the backend sends the user a Telegram welcome message ("You're logged in, here's what you can do...").
3. On every successful Privy login, retrieve the full user profile from Privy and store it in Redis with TTL = remaining Privy token lifetime.

---

## Architecture

```
Mini App (FE)
  │── POST /auth/privy { privyToken, telegramChatId } ──►│
                                                         HttpApiServer
                                                           │── authUseCase.loginWithPrivy(...)
                                                                  │── privyAuthService.verifyToken → PrivyUserProfile
                                                                  │── userProfileCache.store(userId, profile, ttl)
                                                                  │── telegramNotifier.sendMessage(chatId, welcomeMsg)
                                                                  └── return { token, expiresAtEpoch, userId }

Telegram Bot
  /logout
    │── delete session
    └── sendWelcomeWithLoginButton(ctx)   ← same helper used by /start unauthenticated branch
```

---

## File Map

| File | Role |
|---|---|
| `src/use-cases/interface/output/telegramNotifier.interface.ts` | **NEW** port for sending Telegram messages |
| `src/adapters/implementations/output/telegram/botNotifier.ts` | **NEW** grammy-backed implementation of `ITelegramNotifier` |
| `src/use-cases/interface/output/privyAuth.interface.ts` | **Modified** — expand `PrivyVerifiedUser` with profile fields |
| `src/adapters/implementations/output/privyAuth/privyServer.adapter.ts` | **Modified** — populate new profile fields from Privy SDK |
| `src/use-cases/interface/output/cache/userProfile.cache.ts` | **NEW** port for user profile cache |
| `src/adapters/implementations/output/cache/redis.userProfile.ts` | **NEW** Redis adapter for user profile cache |
| `src/use-cases/implementations/auth.usecase.ts` | **Modified** — inject and use notifier + profile cache |
| `src/adapters/implementations/input/telegram/handler.ts` | **Modified** — `/logout` sends welcome; extract `sendWelcomeWithLoginButton` helper |
| `src/adapters/inject/assistant.di.ts` | **Modified** — wire new adapters, pass to `AuthUseCaseImpl` |

---

## Step 1 — New port: `ITelegramNotifier`

**File:** `src/use-cases/interface/output/telegramNotifier.interface.ts`

```typescript
export interface ITelegramNotifier {
  sendMessage(
    chatId: string,
    text: string,
    options?: { webAppButton?: { label: string; url: string } },
  ): Promise<void>;
}
```

**Why a port?** The use case layer must not import grammy. The port is a plain TypeScript interface; the grammy-specific code lives entirely in the adapter.

---

## Step 2 — New adapter: `BotTelegramNotifier`

**File:** `src/adapters/implementations/output/telegram/botNotifier.ts`

```typescript
import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { ITelegramNotifier } from "../../../../use-cases/interface/output/telegramNotifier.interface";

export class BotTelegramNotifier implements ITelegramNotifier {
  constructor(private readonly bot: Bot) {}

  async sendMessage(
    chatId: string,
    text: string,
    options?: { webAppButton?: { label: string; url: string } },
  ): Promise<void> {
    const replyMarkup = options?.webAppButton
      ? new InlineKeyboard().webApp(options.webAppButton.label, options.webAppButton.url)
      : undefined;
    await this.bot.api.sendMessage(Number(chatId), text, {
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
}
```

**Note:** `bot.api.sendMessage` is used (not `ctx.reply`) because the HTTP server does not have a context object — only a `chatId`.

---

## Step 3 — Extend `PrivyVerifiedUser`

**File:** `src/use-cases/interface/output/privyAuth.interface.ts`

Replace the current minimal interface with the full profile shape:

```typescript
export interface PrivyUserProfile {
  privyDid: string;
  email: string;
  googleEmail?: string;
  telegramUserId?: string;
  telegramUsername?: string;
  embeddedWalletAddress?: string;
  linkedExternalWallets: string[];  // 0x addresses of external wallets
  privyCreatedAt?: number;           // unix epoch, when the Privy user was created
}

// Keep old alias so nothing else breaks
export type PrivyVerifiedUser = Pick<PrivyUserProfile, 'privyDid' | 'email'>;

export interface IPrivyAuthService {
  verifyToken(accessToken: string): Promise<PrivyUserProfile>;
  getOrCreateWalletByTelegramId(telegramUserId: string): Promise<string>;
}
```

`verifyToken` now returns the full `PrivyUserProfile`. Because `PrivyUserProfile` is a superset of the old `PrivyVerifiedUser`, all existing call sites that only destructure `{ privyDid, email }` continue to work without changes.

---

## Step 4 — Update `PrivyServerAuthAdapter.verifyToken`

**File:** `src/adapters/implementations/output/privyAuth/privyServer.adapter.ts`

Replace the existing `verifyToken` return with:

```typescript
async verifyToken(accessToken: string): Promise<PrivyUserProfile> {
  const claims = await this.client.verifyAuthToken(accessToken);
  const user = await this.client.getUser(claims.userId);

  const googleAccount = user.linkedAccounts.find((a) => a.type === "google_oauth");
  const telegramAccount = user.linkedAccounts.find((a) => a.type === "telegram");

  const googleEmail = (googleAccount && "email" in googleAccount)
    ? (googleAccount as { email: string }).email
    : undefined;

  const telegramUserId = (telegramAccount && "telegramUserId" in telegramAccount)
    ? (telegramAccount as { telegramUserId: string }).telegramUserId
    : undefined;

  const telegramUsername = (telegramAccount && "username" in telegramAccount)
    ? (telegramAccount as { username?: string }).username
    : undefined;

  const telegramFallbackEmail = telegramUserId
    ? `tg_${telegramUserId}@privy.local`
    : undefined;

  const email = googleEmail
    ?? (user as unknown as { email?: string }).email
    ?? telegramFallbackEmail
    ?? "";

  if (!email) throw new Error("PRIVY_NO_EMAIL");

  const embeddedWallet = user.linkedAccounts.find(
    (a) => a.type === "wallet" && (a as { walletClientType?: string }).walletClientType === "privy",
  );

  const linkedExternalWallets = user.linkedAccounts
    .filter((a) => a.type === "wallet" && (a as { walletClientType?: string }).walletClientType !== "privy")
    .map((a) => (a as { address: string }).address)
    .filter(Boolean);

  const privyCreatedAt = user.createdAt
    ? Math.floor(new Date(user.createdAt).getTime() / 1000)
    : undefined;

  return {
    privyDid: claims.userId,
    email,
    googleEmail,
    telegramUserId,
    telegramUsername,
    embeddedWalletAddress: embeddedWallet && "address" in embeddedWallet
      ? (embeddedWallet as { address: string }).address
      : undefined,
    linkedExternalWallets,
    privyCreatedAt,
  };
}
```

No other methods change.

---

## Step 5 — New port: `IUserProfileCache`

**File:** `src/use-cases/interface/output/cache/userProfile.cache.ts`

```typescript
import type { PrivyUserProfile } from "../privyAuth.interface";

export interface IUserProfileCache {
  store(userId: string, profile: PrivyUserProfile, ttlSeconds: number): Promise<void>;
  get(userId: string): Promise<PrivyUserProfile | null>;
}
```

---

## Step 6 — New adapter: `RedisUserProfileCache`

**File:** `src/adapters/implementations/output/cache/redis.userProfile.ts`

```typescript
import type Redis from "ioredis";
import type { IUserProfileCache } from "../../../../use-cases/interface/output/cache/userProfile.cache";
import type { PrivyUserProfile } from "../../../../use-cases/interface/output/privyAuth.interface";

export class RedisUserProfileCache implements IUserProfileCache {
  constructor(private readonly redis: Redis) {}

  private key(userId: string): string {
    return `user_profile:${userId}`;
  }

  async store(userId: string, profile: PrivyUserProfile, ttlSeconds: number): Promise<void> {
    const safeTtl = Math.max(10, ttlSeconds);
    await this.redis.set(this.key(userId), JSON.stringify(profile), "EX", safeTtl);
  }

  async get(userId: string): Promise<PrivyUserProfile | null> {
    const raw = await this.redis.get(this.key(userId));
    return raw ? (JSON.parse(raw) as PrivyUserProfile) : null;
  }
}
```

---

## Step 7 — Update `AuthUseCaseImpl`

**File:** `src/use-cases/implementations/auth.usecase.ts`

### 7a — New constructor parameters (append after existing, all optional)

```typescript
export class AuthUseCaseImpl implements IAuthUseCase {
  constructor(
    private readonly userDB: IUserDB,
    private readonly jwtSecret: string,
    private readonly jwtExpiresIn: string,
    private readonly privyAuthService?: IPrivyAuthService,
    private readonly telegramSessionDB?: ITelegramSessionDB,
    private readonly telegramNotifier?: ITelegramNotifier,  // NEW
    private readonly userProfileCache?: IUserProfileCache,  // NEW
    private readonly miniAppUrl?: string,                   // NEW — for login button URL in welcome msg
  ) {}
```

Add the two new imports at the top:
```typescript
import type { ITelegramNotifier } from "../interface/output/telegramNotifier.interface";
import type { IUserProfileCache } from "../interface/output/cache/userProfile.cache";
```

### 7b — Add a private welcome message constant

```typescript
private static readonly WELCOME_BACK_TEXT =
  "You're now signed in to Aegis!\n\nYou can:\n• Describe a trade — the agent will parse and execute it\n• Send /new to start a fresh conversation\n• Send /history to see recent messages\n• Send /logout to sign out";
```

### 7c — Update `loginWithPrivy`

After `const result = this.issueJwt(user.id, user.email);` and the telegram session upsert block, add:

```typescript
// Store Privy profile in Redis
if (this.userProfileCache && profile) {
  const ttlSeconds = result.expiresAtEpoch - Math.floor(Date.now() / 1000);
  await this.userProfileCache.store(user.id, profile, ttlSeconds).catch((err) => {
    console.error("[Auth] failed to store user profile:", err);
  });
}

// Notify the user on Telegram
if (input.telegramChatId && this.telegramNotifier) {
  await this.telegramNotifier.sendMessage(
    input.telegramChatId,
    AuthUseCaseImpl.WELCOME_BACK_TEXT,
  ).catch((err) => {
    console.error("[Auth] failed to send Telegram welcome message:", err);
  });
}
```

### 7d — Hold `profile` from `verifyToken`

Replace:
```typescript
const { privyDid, email } = await this.privyAuthService.verifyToken(input.privyToken);
```
with:
```typescript
const profile = await this.privyAuthService.verifyToken(input.privyToken);
const { privyDid, email } = profile;
```

No other changes to `loginWithPrivy`.

---

## Step 8 — Update `handler.ts` — logout sends welcome

**File:** `src/adapters/implementations/input/telegram/handler.ts`

### 8a — Extract helper `sendWelcomeWithLoginButton`

The `/start` unauthenticated branch and `/logout` both need to send the same welcome UI. Extract the shared logic into a private method:

```typescript
private async sendWelcomeWithLoginButton(chatId: number): Promise<void> {
  const miniAppUrl = process.env.MINI_APP_URL;
  const keyboard = miniAppUrl
    ? new InlineKeyboard().webApp("Open Aegis", miniAppUrl)
    : new InlineKeyboard().text("Sign in", "auth:login");
  await this.botRef!.api.sendMessage(
    chatId,
    "Welcome to Aegis.\n\nSign in via the mini app to get started.",
    { reply_markup: keyboard },
  );
}
```

`this.botRef` is already set in `register(bot)` as `this.botRef = bot`.

### 8b — Update `/start` unauthenticated branch

Replace the inline `ctx.reply(...)` block with:
```typescript
if (!session) {
  await this.sendWelcomeWithLoginButton(ctx.chat.id);
  return;
}
```

### 8c — Update `/logout` to send welcome after logging out

```typescript
bot.command("logout", async (ctx) => {
  const chatId = ctx.chat.id;
  await this.telegramSessions.deleteByChatId(String(chatId));
  this.sessionCache.delete(chatId);
  this.conversations.delete(chatId);
  await ctx.reply("Logged out successfully.");
  await this.sendWelcomeWithLoginButton(chatId);
});
```

**Note:** `MINI_APP_URL` is already read from `process.env` in the existing `/start` handler — the helper follows the same pattern and does not introduce a new env var read path.

---

## Step 9 — Wire in `assistant.di.ts`

**File:** `src/adapters/inject/assistant.di.ts`

### 9a — Add imports

```typescript
import { BotTelegramNotifier } from "../implementations/output/telegram/botNotifier";
import { RedisUserProfileCache } from "../implementations/output/cache/redis.userProfile";
```

### 9b — New lazy private fields

```typescript
private _userProfileCache: IUserProfileCache | null = null;
```

### 9c — New getter

```typescript
getUserProfileCache(): IUserProfileCache | undefined {
  const redis = this.getRedis();
  if (!redis) return undefined;
  if (!this._userProfileCache) {
    this._userProfileCache = new RedisUserProfileCache(redis);
  }
  return this._userProfileCache;
}
```

### 9d — Update `getAuthUseCase()` to pass new deps

The current `getAuthUseCase()` constructs `AuthUseCaseImpl` with 5 args. Add the three new optional ones:

```typescript
getAuthUseCase(): IAuthUseCase {
  if (!this._authUseCase) {
    const bot = this.getBot(); // already available in DI
    const notifier = bot ? new BotTelegramNotifier(bot) : undefined;
    this._authUseCase = new AuthUseCaseImpl(
      this.getSqlDB().users,
      process.env.JWT_SECRET!,
      process.env.JWT_EXPIRES_IN ?? "7d",
      this.getPrivyAuthService(),
      this.getSqlDB().telegramSessions,
      notifier,
      this.getUserProfileCache(),
      process.env.MINI_APP_URL,
    );
  }
  return this._authUseCase;
}
```

**Important:** Check how `getBot()` is currently named/accessed in `assistant.di.ts`. If the bot instance is not already exposed as a getter, add one:

```typescript
private _bot: Bot | null = null;
getBot(): Bot | undefined {
  // Bot is constructed in telegramCli.ts and passed in, or constructed here.
  // Check how TelegramAssistantHandler receives its bot and mirror that pattern.
  return this._bot ?? undefined;
}
```

Look at the actual `assistant.di.ts` to confirm whether `Bot` is already a member or is constructed externally. If the bot is constructed outside the DI container (in `telegramCli.ts`), the DI container needs a `setBot(bot: Bot)` method, and `telegramCli.ts` must call it before `getAuthUseCase()` is first invoked.

---

## Step 10 — Add `GET /user/profile` endpoint (optional, low priority)

This is optional for the initial implementation but documents the pattern. Expose the stored Privy profile so the FE can display it:

**File:** `src/adapters/implementations/input/http/httpServer.ts`

```typescript
if (method === 'GET' && url.pathname === '/user/profile') {
  return this.handleGetUserProfile(req, res);
}
```

```typescript
private async handleGetUserProfile(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const userId = this.extractUserId(req);
  if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
  if (!this.userProfileCache) return this.sendJson(res, 503, { error: "Profile cache not available" });

  const profile = await this.userProfileCache.get(userId);
  if (!profile) return this.sendJson(res, 404, { error: "Profile not found or expired" });
  return this.sendJson(res, 200, profile);
}
```

Add `userProfileCache?: IUserProfileCache` to `HttpApiServer` constructor (append, optional) and wire it in `assistant.di.ts`.

---

## Guardrails

### No hardcoded values
- Welcome message text is a private static constant on the use case class, not scattered strings.
- `MINI_APP_URL` is read from env exactly once per call (already the convention).
- Redis key prefix (`user_profile:`) is encapsulated inside `RedisUserProfileCache.key()`.

### No architecture leakage
- `AuthUseCaseImpl` never imports grammy. It only holds the port interface `ITelegramNotifier`.
- `BotTelegramNotifier` lives in the adapter layer (`output/telegram/`) — the only place grammy is allowed.
- `IUserProfileCache` and `ITelegramNotifier` are pure TypeScript interfaces with no framework deps.

### Failure isolation
- Both `userProfileCache.store` and `telegramNotifier.sendMessage` are wrapped in `.catch()` — a Redis or bot API failure does **not** fail the login response. The user still gets their JWT.
- The `loginWithPrivy` return value is unchanged: `{ token, expiresAtEpoch, userId }`.

### Backward compatibility
- All new constructor parameters on `AuthUseCaseImpl` are optional (`?`) — existing unit tests and instantiation sites will not break.
- `PrivyVerifiedUser` is kept as a type alias (`Pick<PrivyUserProfile, ...>`), so any code that destructures only `privyDid` and `email` continues to typecheck.

### Bot reference availability
- Verify in `assistant.di.ts` that the `Bot` instance is accessible before `getAuthUseCase()` is called (the `Bot` is typically constructed in `telegramCli.ts` before DI is used). If there's a chicken-and-egg issue, use a lazy `setBot` setter.

---

## Implementation order

1. Create `ITelegramNotifier` port.
2. Create `BotTelegramNotifier` adapter.
3. Update `PrivyVerifiedUser` → `PrivyUserProfile` in the interface.
4. Update `PrivyServerAuthAdapter.verifyToken` to return full profile.
5. Create `IUserProfileCache` port.
6. Create `RedisUserProfileCache` adapter.
7. Update `AuthUseCaseImpl` (new deps + store profile + send welcome).
8. Update `handler.ts` (extract helper + update `/start` + update `/logout`).
9. Wire everything in `assistant.di.ts`.
10. `npx tsc --noEmit` — must be clean before done.
11. Manual test: `/logout` → welcome + login button appears → tap login → mini app → Privy login → `POST /auth/privy` → Telegram message "You're now signed in" → Redis has profile under `user_profile:{userId}`.
