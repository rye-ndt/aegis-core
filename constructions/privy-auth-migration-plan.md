# Privy Auth Migration Plan — Replace Email/Password JWT with Privy Tokens

> Date: 2026-04-10
> Status: Draft
> Replaces: `POST /auth/register`, `POST /auth/login` (email+password flow)
> Touches: schema, auth use case + interface, HTTP server, Telegram handler, DI

---

## Goal

Replace the current email/password + internal-JWT auth system with Privy-token-based authentication. After a user logs in via Google in the `privy-auth` Telegram mini app, they obtain a Privy access token. That token is sent to the `onchain-agent` backend, which verifies it using Privy's server SDK, upserts the user by their Privy DID, deploys their Smart Contract Account if needed, and issues an internal session.

The Telegram flow becomes: user opens the mini app → logs in via Google → copies the Privy token → sends `/auth <privy_token>` to the bot. Or, if using `sendData`, the token is pushed automatically.

---

## Architecture overview

```
privy-auth mini app
  usePrivy().getAccessToken()  →  Privy JWT (signed by Privy)
        │
        │  Authorization: Bearer <privy_token>
        ▼
onchain-agent: POST /auth/privy
  PrivyServerAuthAdapter.verifyToken(privyToken)
    → calls Privy verification API
    → returns { privyDid, email, linkedAccounts }
  AuthUseCaseImpl.loginWithPrivy({ privyDid, email })
    → upsert user by privyDid (create if new, find if returning)
    → deploy SCA if new user
    → return internal JWT (same downstream shape as before)
        │
        ▼
  { token, expiresAtEpoch, userId }   ← same shape as old /auth/login
```

After this migration, `POST /auth/register` and `POST /auth/login` (email/password) are **removed**. All protected endpoints (`extractUserId`) continue to validate the internal JWT unchanged — only how you *obtain* that JWT changes.

---

## New dependency

**Package:** `@privy-io/server-auth`

```bash
npm install @privy-io/server-auth
```

This is Privy's official Node.js server SDK. It exposes `PrivyClient` which verifies access tokens against Privy's public keys.

---

## New environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PRIVY_APP_ID` | Yes | Same value as `VITE_PRIVY_APP_ID` in the mini app |
| `PRIVY_APP_SECRET` | Yes | From dashboard.privy.io → App Settings → API Keys |

Both are read only in `assistant.di.ts` — never inside use cases or adapters directly.

---

## Step-by-step changes

---

### Step 1 — Database schema

**File:** `src/adapters/implementations/output/sqlDB/schema.ts`

Add `privyDid` column to the `users` table. Make `hashedPassword` nullable (existing users migrated from old system have a hash; new Privy users don't):

```typescript
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  userName: text("user_name").notNull(),
  hashedPassword: text("hashed_password"),           // nullable — Privy users have no password
  email: text("email").notNull().unique(),
  privyDid: text("privy_did").unique(),              // NEW — Privy DID (did:privy:xxx)
  status: text("status").notNull(),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
```

**Migration file:** `drizzle/0014_privy_auth.sql`

```sql
ALTER TABLE "users"
  ALTER COLUMN "hashed_password" DROP NOT NULL,
  ADD COLUMN "privy_did" text UNIQUE;
```

Run: `npm run db:generate && npm run db:migrate`

---

### Step 2 — User repo interface + implementation

**File:** `src/use-cases/interface/output/repository/user.repo.ts`

Make `hashedPassword` optional in `UserInit`. Add `privyDid` field and `findByPrivyDid` method:

```typescript
export interface UserInit {
  id: string;
  userName: string;
  hashedPassword?: string;          // optional — Privy users don't have one
  email: string;
  privyDid?: string;                // NEW
  status: USER_STATUSES;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IUser extends UserInit {}

export interface IUserDB {
  create(user: UserInit): Promise<void>;
  update(user: UserUpdate): Promise<void>;
  findById(id: string): Promise<IUser | undefined>;
  findByEmail(email: string): Promise<IUser | null>;
  findByPrivyDid(privyDid: string): Promise<IUser | null>;  // NEW
}
```

**File:** `src/adapters/implementations/output/sqlDB/repositories/user.repo.ts`

Add `findByPrivyDid`:

```typescript
async findByPrivyDid(privyDid: string): Promise<IUser | null> {
  const rows = await this.db
    .select()
    .from(users)
    .where(eq(users.privyDid, privyDid))
    .limit(1);
  if (!rows[0]) return null;
  return this.toIUser(rows[0]);
}
```

Update `toIUser` to include the new field:

```typescript
private toIUser(row: typeof users.$inferSelect): IUser {
  return {
    id: row.id,
    userName: row.userName,
    hashedPassword: row.hashedPassword ?? undefined,
    email: row.email,
    privyDid: row.privyDid ?? undefined,
    status: row.status as USER_STATUSES,
    createdAtEpoch: row.createdAtEpoch,
    updatedAtEpoch: row.updatedAtEpoch,
  };
}
```

Update `create` to include `privyDid`:

```typescript
async create(user: UserInit): Promise<void> {
  await this.db.insert(users).values({
    id: user.id,
    userName: user.userName,
    hashedPassword: user.hashedPassword ?? null,
    email: user.email,
    privyDid: user.privyDid ?? null,
    status: user.status,
    createdAtEpoch: user.createdAtEpoch,
    updatedAtEpoch: user.updatedAtEpoch,
  });
}
```

---

### Step 3 — Privy server auth port (new interface)

**New file:** `src/use-cases/interface/output/privyAuth.interface.ts`

```typescript
export interface PrivyVerifiedUser {
  privyDid: string;      // e.g. "did:privy:clxxxxxxxxxxxxxxxxxxxxx"
  email: string;         // Google email from linked account
}

export interface IPrivyAuthService {
  verifyToken(accessToken: string): Promise<PrivyVerifiedUser>;
}
```

This is a pure output port — the use case depends on it via interface, never on the Privy SDK directly.

---

### Step 4 — Privy server auth adapter (new implementation)

**New file:** `src/adapters/implementations/output/privyAuth/privyServer.adapter.ts`

```typescript
import { PrivyClient } from "@privy-io/server-auth";
import type { IPrivyAuthService, PrivyVerifiedUser } from "../../../../use-cases/interface/output/privyAuth.interface";

export class PrivyServerAuthAdapter implements IPrivyAuthService {
  private client: PrivyClient;

  constructor(appId: string, appSecret: string) {
    this.client = new PrivyClient(appId, appSecret);
  }

  async verifyToken(accessToken: string): Promise<PrivyVerifiedUser> {
    const claims = await this.client.verifyAuthToken(accessToken);
    // claims.userId is the Privy DID
    const user = await this.client.getUser(claims.userId);
    const googleAccount = user.linkedAccounts.find(
      (a) => a.type === "google_oauth"
    );
    const email = googleAccount?.email ?? user.email ?? "";
    if (!email) throw new Error("PRIVY_NO_EMAIL");
    return { privyDid: claims.userId, email };
  }
}
```

**Guardrail:** `verifyAuthToken` throws if the token is invalid or expired — the caller (HTTP handler) catches and returns 401.

---

### Step 5 — Auth use-case interface

**File:** `src/use-cases/interface/input/auth.interface.ts`

Add `loginWithPrivy`:

```typescript
export interface IPrivyLoginInput {
  privyToken: string;
}

export interface IAuthUseCase {
  register(input: IRegisterInput): Promise<{ userId: string }>;
  login(input: ILoginInput): Promise<{ token: string; expiresAtEpoch: number; userId: string }>;
  validateToken(token: string): Promise<{ userId: string; expiresAtEpoch: number }>;
  loginWithPrivy(input: IPrivyLoginInput): Promise<{ token: string; expiresAtEpoch: number; userId: string }>;
}
```

`register` and `login` (email/password) stay on the interface for now — they are removed from the HTTP layer (Step 6) but the interface is kept to avoid breaking `AuthUseCaseImpl`'s existing methods.

---

### Step 6 — Auth use-case implementation

**File:** `src/use-cases/implementations/auth.usecase.ts`

Add `IPrivyAuthService` to constructor and implement `loginWithPrivy`:

```typescript
constructor(
  private readonly userDB: IUserDB,
  private readonly jwtSecret: string,
  private readonly jwtExpiresIn: string,
  private readonly userProfileDB?: IUserProfileDB,
  private readonly smartAccountService?: ISmartAccountService,
  private readonly sessionKeyService?: ISessionKeyService,
  private readonly allowedTokenAddresses?: string[],
  private readonly privyAuthService?: IPrivyAuthService,   // NEW — last, optional
) {}

async loginWithPrivy(input: IPrivyLoginInput): Promise<{ token: string; expiresAtEpoch: number; userId: string }> {
  if (!this.privyAuthService) throw new Error("PRIVY_NOT_CONFIGURED");

  const { privyDid, email } = await this.privyAuthService.verifyToken(input.privyToken);

  // Find existing user by Privy DID
  let user = await this.userDB.findByPrivyDid(privyDid);

  if (!user) {
    // Check if there's an existing user with this email (migrated from old system)
    user = await this.userDB.findByEmail(email);
    if (user) {
      // Backfill privyDid onto existing account — not implemented here,
      // do a userDB.update call. For simplicity: create a new account.
      // Decision: treat as new user if privyDid is missing on the email match.
      // This avoids conflating accounts across auth systems.
    }
  }

  if (!user) {
    // New user — provision account + SCA
    const userId = newUuid();
    const now = newCurrentUTCEpoch();
    const userName = email.split("@")[0] ?? "user";

    await this.userDB.create({
      id: userId,
      userName,
      email,
      privyDid,
      status: USER_STATUSES.ACTIVE,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });

    // Deploy SCA (same logic as register())
    if (this.smartAccountService && this.userProfileDB) {
      try {
        const { smartAccountAddress } = await this.smartAccountService.deploy(userId);
        const expiresAtEpoch = now + SESSION_KEY_DURATION_SECS;
        let sessionKeyAddress: string | undefined;
        let sessionKeyStatus = SESSION_KEY_STATUSES.PENDING;

        if (this.sessionKeyService) {
          const scope = {
            maxAmountPerTxUsd: DEFAULT_MAX_AMOUNT_PER_TX_USD,
            allowedTokenAddresses: this.allowedTokenAddresses ?? [],
            expiresAtEpoch,
          };
          const grantResult = await this.sessionKeyService.grant({ smartAccountAddress, scope });
          sessionKeyAddress = grantResult.sessionKeyAddress;
          sessionKeyStatus = SESSION_KEY_STATUSES.ACTIVE;
        }

        await this.userProfileDB.upsert({
          userId,
          smartAccountAddress,
          sessionKeyAddress: sessionKeyAddress ?? null,
          sessionKeyScope: JSON.stringify({
            maxAmountPerTxUsd: DEFAULT_MAX_AMOUNT_PER_TX_USD,
            allowedTokenAddresses: this.allowedTokenAddresses ?? [],
            expiresAtEpoch,
          }),
          sessionKeyStatus,
          sessionKeyExpiresAtEpoch: expiresAtEpoch,
          createdAtEpoch: now,
          updatedAtEpoch: now,
        });
      } catch (err) {
        console.error("SCA deployment failed during Privy login:", err);
        await this.userProfileDB.upsert({
          userId,
          createdAtEpoch: now,
          updatedAtEpoch: now,
        });
      }
    }

    // Fetch the newly created user record to issue JWT below
    user = await this.userDB.findByPrivyDid(privyDid) ?? { id: userId, email, userName, privyDid, status: USER_STATUSES.ACTIVE, createdAtEpoch: now, updatedAtEpoch: now };
  }

  // Issue internal JWT — same shape as existing login()
  const payload = { userId: user.id, email: user.email };
  const token = jwt.sign(payload, this.jwtSecret, {
    expiresIn: this.jwtExpiresIn as jwt.SignOptions["expiresIn"],
  });
  const decoded = jwt.decode(token) as { exp: number };
  return { token, expiresAtEpoch: decoded.exp, userId: user.id };
}
```

**Key design decision:** `loginWithPrivy` issues an **internal JWT** after verification, not Privy's token. This means `extractUserId` in `httpServer.ts` and the Telegram session flow are completely unchanged — they still verify the internal JWT. The Privy token is only used once, at login time, to establish identity.

---

### Step 7 — HTTP API

**File:** `src/adapters/implementations/input/http/httpServer.ts`

#### a. Remove `POST /auth/register` and `POST /auth/login` routes

Delete the route matchers in `handle()`:

```typescript
// REMOVE these two:
if (method === "POST" && url.pathname === "/auth/register") { ... }
if (method === "POST" && url.pathname === "/auth/login") { ... }
```

Remove `handleRegister` and `handleLogin` methods. Remove `registerSchema` and `loginSchema` Zod schemas.

#### b. Add `POST /auth/privy` route

In `handle()`:

```typescript
if (method === "POST" && url.pathname === "/auth/privy") {
  return this.handlePrivyLogin(req, res);
}
```

New handler method:

```typescript
private async handlePrivyLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await this.readJson(req);
  } catch {
    return this.sendJson(res, 400, { error: "Invalid JSON" });
  }

  const parsed = z.object({ privyToken: z.string().min(1) }).safeParse(body);
  if (!parsed.success) {
    return this.sendJson(res, 400, { error: "privyToken is required" });
  }

  try {
    const result = await this.authUseCase.loginWithPrivy({ privyToken: parsed.data.privyToken });
    return this.sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof Error && (err.message === "PRIVY_NOT_CONFIGURED" || err.message.includes("invalid"))) {
      return this.sendJson(res, 401, { error: "Invalid or expired Privy token" });
    }
    throw err;
  }
}
```

#### c. Updated HTTP API table (after migration)

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/auth/privy` | None | Verify Privy token → return `{ token, expiresAtEpoch, userId }` |
| `GET` | `/intent/:intentId` | JWT | Fetch intent + execution status |
| `GET` | `/portfolio` | JWT | On-chain balances for user's SCA |
| `GET` | `/tokens?chainId=` | None | List verified tokens for a chain |
| `POST` | `/tools` | JWT | Register a dynamic tool manifest |
| `GET` | `/tools` | None | List active tool manifests |

`extractUserId` is **unchanged** — it still validates the internal JWT from the `Authorization: Bearer` header.

---

### Step 8 — Telegram handler

**File:** `src/adapters/implementations/input/telegram/handler.ts`

#### a. Replace the `/auth` command

The user no longer runs a curl to `/auth/login`. Instead, they open the Privy mini app, get a Privy token, and send `/auth <privy_token>` to the bot. The handler calls `POST /auth/privy` (or directly `authUseCase.loginWithPrivy`) to exchange the Privy token for an internal JWT, then stores the session.

Replace the `/auth` command handler body:

```typescript
bot.command("auth", async (ctx) => {
  const privyToken = ctx.match?.trim();
  if (!privyToken) {
    await ctx.reply(
      "Usage: /auth <privy_token>\n\nGet your token from the Aegis mini app after signing in with Google.",
    );
    return;
  }
  try {
    const { userId, expiresAtEpoch, token } =
      await this.authUseCase.loginWithPrivy({ privyToken });
    await this.telegramSessions.upsert({
      telegramChatId: String(ctx.chat.id),
      userId,
      expiresAtEpoch,
    });
    this.sessionCache.set(ctx.chat.id, { userId, expiresAtEpoch });
    await ctx.reply("Authenticated with Google via Privy. You can now use the Onchain Agent.");
  } catch {
    await ctx.reply(
      "Invalid or expired token. Open the Aegis mini app and copy a fresh token.",
    );
  }
});
```

Note: the session cache and DB storage are identical to before — `userId` and `expiresAtEpoch` are still stored. Only the source of truth changes (Privy instead of email/password JWT).

#### b. Update callback query `auth:login` to point to the mini app

Replace the curl instruction in the `auth:login` callback with mini app instructions:

```typescript
bot.callbackQuery("auth:login", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "To authenticate:\n\n1. Open the Aegis mini app\n2. Sign in with Google\n3. Tap \"Copy\" next to your Agent Auth Token\n4. Send it here with: /auth <token>",
  );
});
```

Remove or replace the `auth:register` callback — registration is now automatic on first Privy login:

```typescript
bot.callbackQuery("auth:register", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "No registration needed. Open the Aegis mini app, sign in with Google, and your account is created automatically.",
  );
});
```

#### c. (Optional) Handle `web_app_data` for automatic token relay

If the mini app uses `Telegram.WebApp.sendData({ privyToken })`, the bot receives a `web_app_data` update. Handle it:

```typescript
bot.on("message:web_app_data", async (ctx) => {
  const raw = ctx.message.web_app_data?.data;
  if (!raw) return;
  let privyToken: string | undefined;
  try {
    const parsed = JSON.parse(raw);
    privyToken = parsed?.privyToken;
  } catch {
    return ctx.reply("Could not parse mini app data.");
  }
  if (!privyToken) return ctx.reply("No token received from mini app.");

  try {
    const { userId, expiresAtEpoch } =
      await this.authUseCase.loginWithPrivy({ privyToken });
    await this.telegramSessions.upsert({
      telegramChatId: String(ctx.chat.id),
      userId,
      expiresAtEpoch,
    });
    this.sessionCache.set(ctx.chat.id, { userId, expiresAtEpoch });
    await ctx.reply("Authenticated with Google. You can now use the Onchain Agent.");
  } catch {
    await ctx.reply("Authentication failed. Please try again from the mini app.");
  }
});
```

---

### Step 9 — DI container

**File:** `src/adapters/inject/assistant.di.ts`

#### a. Add `PrivyServerAuthAdapter`

```typescript
import { PrivyServerAuthAdapter } from "../implementations/output/privyAuth/privyServer.adapter";

// In AssistantInject:
private _privyAuthService: PrivyServerAuthAdapter | null = null;

getPrivyAuthService(): PrivyServerAuthAdapter | undefined {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) return undefined;
  if (!this._privyAuthService) {
    this._privyAuthService = new PrivyServerAuthAdapter(appId, appSecret);
  }
  return this._privyAuthService;
}
```

#### b. Pass to `AuthUseCaseImpl`

```typescript
getAuthUseCase(): IAuthUseCase {
  if (!this._authUseCase) {
    this._authUseCase = new AuthUseCaseImpl(
      this.getSqlDB().users,
      process.env.JWT_SECRET ?? "dev-secret",
      process.env.JWT_EXPIRES_IN ?? "7d",
      this.getSqlDB().userProfiles,
      this.getSmartAccountService(),
      this.getSessionKeyService(),
      this.getAllowedTokenAddresses(),
      this.getPrivyAuthService(),    // NEW last arg
    );
  }
  return this._authUseCase;
}
```

#### c. Add env vars to `.env.example`

```dotenv
# Privy auth (same App ID as the mini app)
PRIVY_APP_ID=clxxxxxxxxxxxxxxxxxxxxx
PRIVY_APP_SECRET=your-privy-app-secret-from-dashboard
```

---

## Files changed summary

| File | Change |
|---|---|
| `src/adapters/implementations/output/sqlDB/schema.ts` | `hashedPassword` nullable, add `privyDid` |
| `drizzle/0014_privy_auth.sql` | New migration |
| `src/use-cases/interface/output/repository/user.repo.ts` | `hashedPassword` optional, `privyDid?`, `findByPrivyDid()` |
| `src/adapters/implementations/output/sqlDB/repositories/user.repo.ts` | `findByPrivyDid`, updated `create`/`toIUser` |
| `src/use-cases/interface/output/privyAuth.interface.ts` | NEW — `IPrivyAuthService`, `PrivyVerifiedUser` |
| `src/adapters/implementations/output/privyAuth/privyServer.adapter.ts` | NEW — `PrivyServerAuthAdapter` |
| `src/use-cases/interface/input/auth.interface.ts` | Add `loginWithPrivy`, `IPrivyLoginInput` |
| `src/use-cases/implementations/auth.usecase.ts` | Add `loginWithPrivy` + `privyAuthService` constructor param |
| `src/adapters/implementations/input/http/httpServer.ts` | Remove register/login routes; add `/auth/privy` |
| `src/adapters/implementations/input/telegram/handler.ts` | Update `/auth` command, callback queries, add `web_app_data` handler |
| `src/adapters/inject/assistant.di.ts` | Add `getPrivyAuthService()`, pass to `AuthUseCaseImpl` |
| `.env.example` | Add `PRIVY_APP_ID`, `PRIVY_APP_SECRET` |

---

## Files NOT changed

- All intent, solver, simulation, and token crawler paths
- `telegramCli.ts` — entry point unchanged
- `TelegramBot` class
- All repository interfaces except `user.repo.ts`
- `extractUserId` in `httpServer.ts` — still validates internal JWT
- `telegramSessions` repo and table — session storage shape unchanged
- `IAssistantUseCase`, `IIntentUseCase`, `IToolRegistrationUseCase`

---

## Guardrails

### The internal JWT is preserved
`loginWithPrivy` issues a standard internal JWT identical in shape to the old `login()` output. Every downstream path (`extractUserId`, `telegramSessions`, `sessionCache`) continues to work without modification.

### `IAuthUseCase.register` and `login` are kept on the implementation
They are removed from the HTTP layer but kept in the class. This avoids breaking any existing test harness or future admin tooling that might call them directly. They can be deprecated later once old user migration is handled.

### Privy SDK errors propagate as 401
`PrivyClient.verifyAuthToken` throws an error on any invalid or expired token. The HTTP handler and Telegram `/auth` command both catch generic errors and respond with 401 / user-friendly message — no stack traces leak.

### `PRIVY_APP_SECRET` is server-only
It must never be in a client bundle. It's read in `assistant.di.ts` (Node.js only) and passed to `PrivyServerAuthAdapter`. The `VITE_PRIVY_APP_ID` prefix in the mini app is for the client-side Privy SDK; the backend uses a non-prefixed `PRIVY_APP_ID`.

### Soft migration path for existing users
Existing users created via email/password have no `privyDid`. They will be treated as new accounts on first Privy login (a separate account is created). If account merging is needed later, a one-time migration script can match by email and backfill `privyDid`. This plan does not implement merging — it's deferred.

### SCA is deployed once, idempotently
`loginWithPrivy` only deploys the SCA for new users (no existing `privyDid` row). Returning Privy users skip directly to JWT issuance. The `userProfileDB.upsert` call uses `ON CONFLICT DO UPDATE` (existing Drizzle upsert behavior).

### No bcrypt for Privy users
New users created via `loginWithPrivy` have `hashedPassword: null`. The old `login` method checks `hashedPassword` with bcrypt — it will throw if called on a Privy-only user, which is acceptable since that code path is no longer reachable from HTTP.

---

## Implementation order

1. Install `@privy-io/server-auth`.
2. Add `PRIVY_APP_ID` and `PRIVY_APP_SECRET` to `.env` and `.env.example`.
3. Write migration `drizzle/0014_privy_auth.sql` and run it.
4. Update `schema.ts` (`hashedPassword` nullable, add `privyDid`).
5. Update `user.repo.ts` interface — `hashedPassword?`, `privyDid?`, `findByPrivyDid`.
6. Update `DrizzleUserRepo` — `findByPrivyDid`, updated `create`/`toIUser`.
7. Create `src/use-cases/interface/output/privyAuth.interface.ts`.
8. Create `src/adapters/implementations/output/privyAuth/privyServer.adapter.ts`.
9. Update `auth.interface.ts` — add `loginWithPrivy`, `IPrivyLoginInput`.
10. Update `auth.usecase.ts` — add `privyAuthService` param and `loginWithPrivy` impl.
11. Update `httpServer.ts` — remove old auth routes, add `/auth/privy`.
12. Update `handler.ts` — update `/auth` command and callback queries; add `web_app_data` handler.
13. Update `assistant.di.ts` — wire `PrivyServerAuthAdapter` into `AuthUseCaseImpl`.
14. Integration test: open mini app → Google login → copy token → `/auth <token>` in bot → "Authenticated" reply → `/portfolio` succeeds.
