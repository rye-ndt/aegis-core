# HTTP Auth Plan

## Goal

Replace the Telegram allowlist mechanism with a proper registration/authentication system:
- HTTP API server (new input adapter) exposes `POST /auth/register`, `POST /auth/login`, `GET /auth/google` and absorbs the existing Google OAuth callback
- JWT-based authentication: user registers/logs in via the API, receives a bearer token
- Telegram `/auth <token>`: user pastes their JWT into Telegram; the bot validates it and creates a persistent session
- Every subsequent Telegram message is gated by session validity
- `allowed_telegram_ids` table and all its plumbing are removed

---

## Pre-Work: Read These Files Before Starting

Read every file listed below in full before writing a single line of code.

```
src/adapters/implementations/output/sqlDB/schema.ts
src/use-cases/interface/output/repository/user.repo.ts
src/adapters/implementations/output/sqlDB/repositories/user.repo.ts
src/use-cases/interface/output/repository/allowedTelegramId.repo.ts
src/adapters/implementations/output/sqlDB/repositories/allowedTelegramId.repo.ts
src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts
src/adapters/inject/assistant.di.ts
src/telegramCli.ts
src/adapters/implementations/input/telegram/handler.ts
src/adapters/implementations/input/telegram/bot.ts
src/adapters/implementations/output/googleOAuth/googleOAuth.service.ts
src/helpers/enums/statuses.enum.ts
.env.example
```

---

## Conventions (Never Violate)

- IDs: always `newUuid()` from `src/helpers/uuid.ts`
- Timestamps: always `newCurrentUTCEpoch()` from `src/helpers/time/dateTime.ts`
- All `*_at_epoch` columns store **seconds**, not milliseconds
- No comments except for unit-conversion quirks, crash-recovery edge cases, or non-obvious performance decisions
- No new files unless the step explicitly says "create new file"
- Run `npm run db:generate && npm run db:migrate` after any schema change before proceeding to code
- Do not suppress TypeScript errors with `as any` or `@ts-ignore`

---

## New Packages

Install before touching any code:

```bash
npm install jsonwebtoken bcryptjs
npm install --save-dev @types/jsonwebtoken @types/bcryptjs
```

**Guardrail:** Use `bcryptjs` (pure JS, no native bindings). Do NOT use `bcrypt` (native). Do NOT use `crypto.createHash` for passwords.

---

## Architecture of the Final State

```
User calls POST /auth/register (email, password, username)
  → creates row in `users` table, returns { userId }

User calls POST /auth/login (email, password)
  → verifies hash, signs JWT { userId, email, exp }
  → returns { token, expiresAtEpoch, userId }

User sends /auth <token> in Telegram
  → bot validates token via AuthUseCaseImpl.validateToken() — exactly once
  → extracts { userId, expiresAtEpoch } from verified claims
  → stores { telegramChatId, userId, expiresAtEpoch } in `telegram_sessions` table (token discarded)
  → caches { userId, expiresAtEpoch } in memory for this process
  → replies "Authenticated."

User sends any Telegram message
  → ensureAuthenticated(chatId): check memory cache → check DB session → verify not expired
  → if expired/missing: reply "Please authenticate. Use /auth <token>."
  → if valid: proceed with userId from session (NOT from UUIDv5 derivation)

User calls GET /auth/google (Authorization: Bearer <token>)
  → validates token → extracts userId
  → returns { url: googleOAuthService.generateAuthUrl(userId) }

Google redirects to GET /api/auth/google/calendar/callback?code=...&state=<userId>
  → googleOAuthService.handleCallback(code, userId)
  → returns HTML confirmation
```

---

## Step 1 — Schema: Remove `fullName`, `dob` from `users`; add unique on `email`; remove `allowedTelegramIds` table

**File:** `src/adapters/implementations/output/sqlDB/schema.ts`

### 1a — Update `users` table
Remove the `fullName` and `dob` column definitions entirely. Add `.unique()` to the `email` column.

Before (relevant lines):
```typescript
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  fullName: text("full_name").notNull(),
  userName: text("user_name").notNull(),
  hashedPassword: text("hashed_password").notNull(),
  email: text("email").notNull(),
  dob: integer("dob").notNull(),
  ...
```

After:
```typescript
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  userName: text("user_name").notNull(),
  hashedPassword: text("hashed_password").notNull(),
  email: text("email").notNull().unique(),
  ...
```

### 1b — Remove `allowedTelegramIds` table
Delete the entire `allowedTelegramIds` export from schema.ts. Drizzle will generate a DROP TABLE migration.

### 1c — Run migration
```bash
npm run db:generate && npm run db:migrate
```

Verify the generated migration SQL contains:
- `ALTER TABLE users DROP COLUMN full_name`
- `ALTER TABLE users DROP COLUMN dob`
- `ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email)` (or equivalent)
- `DROP TABLE allowed_telegram_ids`

**Guardrail:** Do not proceed to Step 2 until the migration runs without error.

---

## Step 2 — Schema: Add `telegram_sessions` table

**File:** `src/adapters/implementations/output/sqlDB/schema.ts`

Add after the `allowedTelegramIds` deletion (where it used to be):

```typescript
export const telegramSessions = pgTable("telegram_sessions", {
  telegramChatId: text("telegram_chat_id").primaryKey(),
  userId: uuid("user_id").notNull(),
  expiresAtEpoch: integer("expires_at_epoch").notNull(),
  createdAtEpoch: integer("created_at_epoch").notNull(),
});
```

The token is **not stored**. The JWT is validated once at `/auth` time; only the derived facts (`userId`, `expiresAtEpoch`) are persisted. The token is discarded after extraction.

Run:
```bash
npm run db:generate && npm run db:migrate
```

Verify the migration contains `CREATE TABLE telegram_sessions`.

---

## Step 3 — Interface: Update `IUser`, `UserInit`, `UserUpdate`, `IUserDB`

**File:** `src/use-cases/interface/output/repository/user.repo.ts`

### 3a — Remove `fullName` and `dob` from all types
Remove `fullName: string` and `dob: number` from `UserInit`, `UserUpdate`, and `IUser`.

### 3b — Add `findByEmail` to `IUserDB`
```typescript
findByEmail(email: string): Promise<IUser | null>;
```

Final interface should be:
```typescript
export interface UserInit {
  id: string;
  userName: string;
  hashedPassword: string;
  email: string;
  status: USER_STATUSES;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface UserUpdate {
  id: string;
  userName: string;
  hashedPassword: string;
  email: string;
  status: USER_STATUSES;
  updatedAtEpoch: number;
}

export interface IUser extends UserInit {
  personalities: PERSONALITIES[];
  secondaryPersonalities: string[];
}

export interface IUserDB {
  create(user: UserInit): Promise<void>;
  update(user: UserUpdate): Promise<void>;
  findById(id: string): Promise<IUser | undefined>;
  findByEmail(email: string): Promise<IUser | null>;
}
```

---

## Step 4 — Repo: Update `DrizzleUserRepo`

**File:** `src/adapters/implementations/output/sqlDB/repositories/user.repo.ts`

### 4a — Remove `fullName` and `dob` from `create()`
Remove `fullName: user.fullName` and `dob: user.dob` from the `.values({...})` call.

### 4b — Remove `fullName` and `dob` from `update()`
Remove `fullName: user.fullName` and `dob: user.dob` from the `.set({...})` call.

### 4c — Remove `fullName` and `dob` from `toIUser()`
Remove `fullName` and `dob` from the returned object spread. Since `toIUser` uses `...row`, explicitly list the fields instead of spreading, omitting `fullName` and `dob`.

Updated `toIUser`:
```typescript
private toIUser(row: typeof users.$inferSelect): IUser {
  return {
    id: row.id,
    userName: row.userName,
    hashedPassword: row.hashedPassword,
    email: row.email,
    status: row.status as USER_STATUSES,
    personalities: row.personalities as PERSONALITIES[],
    secondaryPersonalities: row.secondaryPersonalities,
    createdAtEpoch: row.createdAtEpoch,
    updatedAtEpoch: row.updatedAtEpoch,
  };
}
```

### 4d — Implement `findByEmail`
```typescript
async findByEmail(email: string): Promise<IUser | null> {
  const rows = await this.db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!rows[0]) return null;
  return this.toIUser(rows[0]);
}
```

### 4e — Remove `findByUsernameOrEmail`
This method is no longer needed — `findByEmail` replaces it. Delete the `findByUsernameOrEmail` method entirely from `DrizzleUserRepo`.

**Guardrail:** After this step, run `npx tsc --noEmit` and verify there are no errors related to `user.repo.ts`. If `findByUsernameOrEmail` is called anywhere else, fix those call sites.

---

## Step 5 — Delete obsolete AllowedTelegramId files

Delete these two files entirely:
- `src/use-cases/interface/output/repository/allowedTelegramId.repo.ts`
- `src/adapters/implementations/output/sqlDB/repositories/allowedTelegramId.repo.ts`

Do not create replacements. Their functionality is replaced by JWT session auth.

---

## Step 6 — Interface: New `ITelegramSessionDB`

**Create new file:** `src/use-cases/interface/output/repository/telegramSession.repo.ts`

```typescript
export interface ITelegramSession {
  telegramChatId: string;
  userId: string;
  expiresAtEpoch: number;
  createdAtEpoch: number;
}

export interface TelegramSessionUpsert {
  telegramChatId: string;
  userId: string;
  expiresAtEpoch: number;
}

export interface ITelegramSessionDB {
  findByChatId(telegramChatId: string): Promise<ITelegramSession | null>;
  upsert(session: TelegramSessionUpsert): Promise<void>;
  deleteByChatId(telegramChatId: string): Promise<void>;
  deleteExpired(nowEpoch: number): Promise<void>;
}
```

No `token` field anywhere in this interface. The repo stores and returns only `userId` + `expiresAtEpoch` — the verified claims, not the credential.

---

## Step 7 — Repo: New `DrizzleTelegramSessionRepo`

**Create new file:** `src/adapters/implementations/output/sqlDB/repositories/telegramSession.repo.ts`

```typescript
import { eq, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { newCurrentUTCEpoch } from "../../../../../helpers/time/dateTime";
import type {
  ITelegramSession,
  ITelegramSessionDB,
  TelegramSessionUpsert,
} from "../../../../../use-cases/interface/output/repository/telegramSession.repo";
import { telegramSessions } from "../schema";

export class DrizzleTelegramSessionRepo implements ITelegramSessionDB {
  constructor(private readonly db: NodePgDatabase) {}

  async findByChatId(telegramChatId: string): Promise<ITelegramSession | null> {
    const rows = await this.db
      .select()
      .from(telegramSessions)
      .where(eq(telegramSessions.telegramChatId, telegramChatId))
      .limit(1);
    if (!rows[0]) return null;
    return {
      telegramChatId: rows[0].telegramChatId,
      userId: rows[0].userId,
      expiresAtEpoch: rows[0].expiresAtEpoch,
      createdAtEpoch: rows[0].createdAtEpoch,
    };
  }

  async upsert(session: TelegramSessionUpsert): Promise<void> {
    await this.db
      .insert(telegramSessions)
      .values({
        telegramChatId: session.telegramChatId,
        userId: session.userId,
        expiresAtEpoch: session.expiresAtEpoch,
        createdAtEpoch: newCurrentUTCEpoch(),
      })
      .onConflictDoUpdate({
        target: telegramSessions.telegramChatId,
        set: {
          userId: session.userId,
          expiresAtEpoch: session.expiresAtEpoch,
        },
      });
  }

  async deleteByChatId(telegramChatId: string): Promise<void> {
    await this.db
      .delete(telegramSessions)
      .where(eq(telegramSessions.telegramChatId, telegramChatId));
  }

  async deleteExpired(nowEpoch: number): Promise<void> {
    await this.db
      .delete(telegramSessions)
      .where(lte(telegramSessions.expiresAtEpoch, nowEpoch));
  }
}
```

---

## Step 8 — Adapter: Update `DrizzleSqlDB`

**File:** `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts`

### 8a — Remove `allowedTelegramIds`
- Delete the import of `DrizzleAllowedTelegramIdRepo`
- Delete `readonly allowedTelegramIds: DrizzleAllowedTelegramIdRepo` property
- Delete `this.allowedTelegramIds = new DrizzleAllowedTelegramIdRepo(this.db)` from constructor

### 8b — Add `telegramSessions`
- Add import: `import { DrizzleTelegramSessionRepo } from "./repositories/telegramSession.repo";`
- Add property: `readonly telegramSessions: DrizzleTelegramSessionRepo;`
- In constructor: `this.telegramSessions = new DrizzleTelegramSessionRepo(this.db);`

---

## Step 9 — Interface: New `IAuthUseCase`

**Create new file:** `src/use-cases/interface/input/auth.interface.ts`

```typescript
export interface IRegisterInput {
  email: string;
  password: string;
  username: string;
}

export interface ILoginInput {
  email: string;
  password: string;
}

export interface IAuthUseCase {
  register(input: IRegisterInput): Promise<{ userId: string }>;
  login(input: ILoginInput): Promise<{ token: string; expiresAtEpoch: number; userId: string }>;
  validateToken(token: string): Promise<{ userId: string; expiresAtEpoch: number }>;
}
```

---

## Step 10 — Use Case: New `AuthUseCaseImpl`

**Create new file:** `src/use-cases/implementations/auth.usecase.ts`

```typescript
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import { USER_STATUSES } from "../../helpers/enums/statuses.enum";
import type { IUserDB } from "../interface/output/repository/user.repo";
import type {
  IAuthUseCase,
  ILoginInput,
  IRegisterInput,
} from "../interface/input/auth.interface";

const BCRYPT_ROUNDS = 10;

export class AuthUseCaseImpl implements IAuthUseCase {
  constructor(
    private readonly userDB: IUserDB,
    private readonly jwtSecret: string,
    private readonly jwtExpiresIn: string,
  ) {}

  async register(input: IRegisterInput): Promise<{ userId: string }> {
    const existing = await this.userDB.findByEmail(input.email);
    if (existing) throw new Error("EMAIL_TAKEN");

    const hashedPassword = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const now = newCurrentUTCEpoch();
    const userId = newUuid();

    await this.userDB.create({
      id: userId,
      userName: input.username,
      hashedPassword,
      email: input.email,
      status: USER_STATUSES.ACTIVE,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });

    return { userId };
  }

  async login(input: ILoginInput): Promise<{ token: string; expiresAtEpoch: number; userId: string }> {
    const user = await this.userDB.findByEmail(input.email);
    if (!user) throw new Error("INVALID_CREDENTIALS");

    const match = await bcrypt.compare(input.password, user.hashedPassword);
    if (!match) throw new Error("INVALID_CREDENTIALS");

    const payload = { userId: user.id, email: user.email };
    const token = jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.jwtExpiresIn as jwt.SignOptions["expiresIn"],
    });

    const decoded = jwt.decode(token) as { exp: number };
    return { token, expiresAtEpoch: decoded.exp, userId: user.id };
  }

  async validateToken(token: string): Promise<{ userId: string; expiresAtEpoch: number }> {
    const payload = jwt.verify(token, this.jwtSecret) as { userId: string; exp: number };
    return { userId: payload.userId, expiresAtEpoch: payload.exp };
  }
}
```

**Guardrails:**
- Never log or return the raw password anywhere in this file
- `INVALID_CREDENTIALS` must be the same error message for both "user not found" and "wrong password" — do not distinguish between them to prevent user enumeration
- `EMAIL_TAKEN` is a different error so the HTTP layer can return 409 specifically for it
- `jwt.verify` throws if token is expired or invalid — do not catch inside `validateToken`; let the caller handle it

---

## Step 11 — Input Adapter: New `HttpApiServer`

**Create new file:** `src/adapters/implementations/input/http/httpServer.ts`

```typescript
import http from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { GoogleOAuthService } from "../googleOAuth/googleOAuth.service";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  username: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export class HttpApiServer {
  private server: http.Server;

  constructor(
    private readonly authUseCase: IAuthUseCase,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly port: number,
  ) {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error("HttpApiServer unhandled error:", err);
        this.sendJson(res, 500, { error: "Internal server error" });
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const base = `http://localhost`;
    const url = new URL(req.url ?? "/", base);
    const method = req.method?.toUpperCase();

    if (method === "POST" && url.pathname === "/auth/register") {
      return this.handleRegister(req, res);
    }
    if (method === "POST" && url.pathname === "/auth/login") {
      return this.handleLogin(req, res);
    }
    if (method === "GET" && url.pathname === "/auth/google") {
      return this.handleGoogleAuthUrl(req, res);
    }
    if (method === "GET" && url.pathname === "/api/auth/google/calendar/callback") {
      return this.handleGoogleCallback(req, res, url);
    }

    res.writeHead(404);
    res.end("Not found");
  }

  private async handleRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch {
      return this.sendJson(res, 400, { error: "Invalid JSON" });
    }

    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return this.sendJson(res, 400, { error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }

    try {
      const result = await this.authUseCase.register(parsed.data);
      return this.sendJson(res, 201, result);
    } catch (err) {
      if (err instanceof Error && err.message === "EMAIL_TAKEN") {
        return this.sendJson(res, 409, { error: "Email already registered" });
      }
      throw err;
    }
  }

  private async handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch {
      return this.sendJson(res, 400, { error: "Invalid JSON" });
    }

    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return this.sendJson(res, 400, { error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }

    try {
      const result = await this.authUseCase.login(parsed.data);
      return this.sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof Error && err.message === "INVALID_CREDENTIALS") {
        return this.sendJson(res, 401, { error: "Invalid email or password" });
      }
      throw err;
    }
  }

  private async handleGoogleAuthUrl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = this.extractBearerToken(req);
    if (!token) {
      return this.sendJson(res, 401, { error: "Missing authorization token" });
    }

    let userId: string;
    try {
      const validated = await this.authUseCase.validateToken(token);
      userId = validated.userId;
    } catch {
      return this.sendJson(res, 401, { error: "Invalid or expired token" });
    }

    const url = this.googleOAuthService.generateAuthUrl(userId);
    return this.sendJson(res, 200, { url });
  }

  private async handleGoogleCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const code = url.searchParams.get("code");
    const userId = url.searchParams.get("state");

    if (!code || !userId) {
      res.writeHead(400);
      res.end("Missing code or state parameter.");
      return;
    }

    try {
      await this.googleOAuthService.handleCallback(code, userId);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><h2>Authorization complete.</h2><p>Return to Telegram — you're all set.</p></body></html>`);
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.writeHead(500);
      res.end("Authorization failed. The code may be expired. Try again.");
    }
  }

  private extractBearerToken(req: http.IncomingMessage): string | null {
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) return null;
    return auth.slice(7);
  }

  private readJson(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON")); }
      });
      req.on("error", reject);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  start(): void {
    this.server.listen(this.port, () => {
      console.log(`HTTP API server listening on port ${this.port}`);
    });
  }

  stop(): void {
    this.server.close();
  }
}
```

**Guardrails:**
- Do NOT import `IAuthUseCase` as a concrete class — always import the interface
- The `handleGoogleCallback` path is identical in behavior to the removed OAuth server in `telegramCli.ts` — replace, do not duplicate
- Zod `safeParse` — always use `issues[0]?.message` for the first error, never expose the full Zod error object to the caller

---

## Step 12 — Update `TelegramAssistantHandler`

**File:** `src/adapters/implementations/input/telegram/handler.ts`

This is the largest change. Read the whole file before starting.

### 12a — Remove imports
Delete:
- `import { v5 as uuidV5 } from "uuid";`
- Import of `IAllowedTelegramIdDB`

Add:
- `import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";`
- `import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";`
- `import type { ITelegramSessionDB } from "../../../../use-cases/interface/output/repository/telegramSession.repo";`

### 12b — Remove `TELEGRAM_NS` constant
Delete: `const TELEGRAM_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";`

### 12c — Update `SetupSession` type
Add `userId` field:
```typescript
interface SetupSession {
  phase: SetupPhase;
  collectedTraits: PERSONALITIES[];
  userId: string;
}
```

### 12d — Update constructor
Remove parameters: `allowedTelegramIds: IAllowedTelegramIdDB`, `adminChatId: number | undefined`
Add parameters: `authUseCase: IAuthUseCase`, `telegramSessions: ITelegramSessionDB`

Add private field:
```typescript
private sessionCache = new Map<number, { userId: string; expiresAtEpoch: number }>();
```

New constructor signature:
```typescript
constructor(
  private readonly assistantUseCase: IAssistantUseCase,
  private readonly userProfileRepo: IUserProfileDB,
  private readonly googleOAuthService: GoogleOAuthService,
  private readonly tts: ITextToSpeech,
  private readonly authUseCase: IAuthUseCase,
  private readonly telegramSessions: ITelegramSessionDB,
  private readonly botToken?: string,
) {}
```

### 12e — Add `ensureAuthenticated` private helper
```typescript
private async ensureAuthenticated(chatId: number): Promise<{ userId: string } | null> {
  const now = newCurrentUTCEpoch();
  const cached = this.sessionCache.get(chatId);
  if (cached) {
    if (cached.expiresAtEpoch > now) return { userId: cached.userId };
    this.sessionCache.delete(chatId);
    await this.telegramSessions.deleteByChatId(String(chatId));
    return null;
  }
  const session = await this.telegramSessions.findByChatId(String(chatId));
  if (!session) return null;
  if (session.expiresAtEpoch <= now) {
    await this.telegramSessions.deleteByChatId(String(chatId));
    return null;
  }
  this.sessionCache.set(chatId, { userId: session.userId, expiresAtEpoch: session.expiresAtEpoch });
  return { userId: session.userId };
}
```

### 12f — Remove private helpers
Delete entirely:
- `resolveUserId(chatId: number): string`
- `isAllowed(chatId: number): Promise<boolean>`

### 12g — Update `register(bot)` — replace all commands and handlers

**`/start` command:**
```typescript
bot.command("start", async (ctx) => {
  const session = await this.ensureAuthenticated(ctx.chat.id);
  if (!session) {
    await ctx.reply("JARVIS online.\n\nAuthenticate first: call POST /auth/login to get a token, then send /auth <token> here.");
    return;
  }
  await ctx.reply("JARVIS online. Send me a message.\n\nRun /setup to personalize your experience.");
});
```

**`/auth <token>` command (new):**
```typescript
bot.command("auth", async (ctx) => {
  const token = ctx.match?.trim();
  if (!token) {
    await ctx.reply("Usage: /auth <your_token>\n\nGet a token via POST /auth/login.");
    return;
  }
  try {
    const { userId, expiresAtEpoch } = await this.authUseCase.validateToken(token);
    // Token is verified exactly once here. Only the derived claims are persisted.
    // The token itself is never stored.
    await this.telegramSessions.upsert({
      telegramChatId: String(ctx.chat.id),
      userId,
      expiresAtEpoch,
    });
    this.sessionCache.set(ctx.chat.id, { userId, expiresAtEpoch });
    await ctx.reply("Authenticated. You can now use JARVIS.");
  } catch {
    await ctx.reply("Invalid or expired token. Get a fresh token via POST /auth/login.");
  }
});
```

**Guardrail:** `token` is used only to call `validateToken()`. It must not be passed to `upsert()`, logged, or stored anywhere. After this block, `token` goes out of scope and is discarded.

**`/new` command:**
```typescript
bot.command("new", async (ctx) => {
  const session = await this.ensureAuthenticated(ctx.chat.id);
  if (!session) {
    await ctx.reply("Please authenticate first. Use /auth <token>.");
    return;
  }
  this.conversations.delete(ctx.chat.id);
  await ctx.reply("Conversation reset. Starting fresh.");
});
```

**`/history` command:**
```typescript
bot.command("history", async (ctx) => {
  const session = await this.ensureAuthenticated(ctx.chat.id);
  if (!session) {
    await ctx.reply("Please authenticate first. Use /auth <token>.");
    return;
  }
  const conversationId = this.conversations.get(ctx.chat.id);
  if (!conversationId) {
    return ctx.reply("No active conversation yet. Send a message first.");
  }
  const messages = await this.assistantUseCase.getConversation({
    userId: session.userId,
    conversationId,
  });
  const text = messages
    .slice(-10)
    .map((m) => `${m.role === "user" ? "You" : "JARVIS"}: ${m.content}`)
    .join("\n\n");
  return ctx.reply(text || "No messages yet.");
});
```

**`/setup` command:**
```typescript
bot.command("setup", async (ctx) => {
  const session = await this.ensureAuthenticated(ctx.chat.id);
  if (!session) {
    await ctx.reply("Please authenticate first. Use /auth <token>.");
    return;
  }
  this.setupSessions.set(ctx.chat.id, {
    phase: { name: "traits", questionIndex: 0 },
    collectedTraits: [],
    userId: session.userId,
  });
  await this.safeSend(
    ctx,
    "Let's personalize JARVIS for you. Answer each question with *a* or *b*.\n\n" +
      TRAIT_QUESTIONS[0].text,
  );
});
```

**`/code` command:**
```typescript
bot.command("code", async (ctx) => {
  const session = await this.ensureAuthenticated(ctx.chat.id);
  if (!session) {
    await ctx.reply("Please authenticate first. Use /auth <token>.");
    return;
  }
  const code = ctx.match?.trim();
  if (!code) {
    return ctx.reply(
      "Usage: /code <authorization_code>\n\nCopy the `code` value from the redirect URL after authorizing Google.",
    );
  }
  try {
    await this.googleOAuthService.handleCallback(code, session.userId);
    await ctx.reply("Google account connected. Calendar and Gmail are ready.");
  } catch {
    await ctx.reply(
      "Authorization failed. The code may be expired — use /setup to get a fresh link.",
    );
  }
});
```

**`/speech` command:**
```typescript
bot.command("speech", async (ctx) => {
  const session = await this.ensureAuthenticated(ctx.chat.id);
  if (!session) {
    await ctx.reply("Please authenticate first. Use /auth <token>.");
    return;
  }
  const message = ctx.match?.trim();
  if (!message) {
    return ctx.reply("Usage: /speech <your message>");
  }
  await this.ensureUserProfile(session.userId, ctx.chat.id);
  const conversationId = this.conversations.get(ctx.chat.id);
  await ctx.replyWithChatAction("record_voice");
  try {
    const response = await this.assistantUseCase.chat({
      userId: session.userId,
      conversationId,
      message,
    });
    this.conversations.set(ctx.chat.id, response.conversationId);
    try {
      const { audioBuffer } = await this.tts.synthesize({ text: response.reply });
      await ctx.replyWithVoice(new InputFile(audioBuffer, "reply.ogg"));
      if (response.toolsUsed.length > 0) {
        await ctx.reply(`[tools: ${response.toolsUsed.join(", ")}]`);
      }
    } catch (ttsErr) {
      console.error("TTS synthesis failed:", ttsErr);
      let reply = response.reply;
      if (response.toolsUsed.length > 0) reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
      await this.safeSend(ctx, `${reply}\n\n_(voice unavailable)_`);
    }
  } catch (err) {
    console.error("Error handling /speech:", err);
    await ctx.reply("Sorry, something went wrong. Please try again.");
  }
});
```

**`message:voice` handler:**
```typescript
bot.on("message:voice", async (ctx) => {
  if (this.setupSessions.has(ctx.chat.id)) return;
  const session = await this.ensureAuthenticated(ctx.chat.id);
  if (!session) {
    await ctx.reply("Please authenticate first. Use /auth <token>.");
    return;
  }
  await this.ensureUserProfile(session.userId, ctx.chat.id);
  const conversationId = this.conversations.get(ctx.chat.id);
  await ctx.replyWithChatAction("record_voice");
  try {
    const audioBuffer = await this.downloadVoiceAsBuffer(ctx);
    const response = await this.assistantUseCase.voiceChat({
      userId: session.userId,
      conversationId,
      audioBuffer,
      mimeType: "audio/ogg",
    });
    this.conversations.set(ctx.chat.id, response.conversationId);
    try {
      const { audioBuffer: replyAudio } = await this.tts.synthesize({ text: response.reply });
      await ctx.replyWithVoice(new InputFile(replyAudio, "reply.ogg"));
      if (response.toolsUsed.length > 0) {
        await ctx.reply(`[tools: ${response.toolsUsed.join(", ")}]`);
      }
    } catch (ttsErr) {
      console.error("TTS failed for voice reply:", ttsErr);
      let reply = response.reply;
      if (response.toolsUsed.length > 0) reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
      await this.safeSend(ctx, `${reply}\n\n_(voice reply unavailable)_`);
    }
  } catch (err) {
    console.error("Error handling voice message:", err);
    await ctx.reply("Sorry, I couldn't process that voice message. Please try again.");
  }
});
```

**`message:photo` handler:**
```typescript
bot.on("message:photo", async (ctx) => {
  if (this.setupSessions.has(ctx.chat.id)) return;
  const session = await this.ensureAuthenticated(ctx.chat.id);
  if (!session) {
    await ctx.reply("Please authenticate first. Use /auth <token>.");
    return;
  }
  await this.ensureUserProfile(session.userId, ctx.chat.id);
  const conversationId = this.conversations.get(ctx.chat.id);
  await ctx.replyWithChatAction("typing");
  try {
    const imageBase64Url = await this.downloadPhotoAsBase64(ctx);
    const caption = ctx.message.caption?.trim() || "[image]";
    const response = await this.assistantUseCase.chat({
      userId: session.userId,
      conversationId,
      message: caption,
      imageBase64Url,
    });
    this.conversations.set(ctx.chat.id, response.conversationId);
    let reply = response.reply;
    if (response.toolsUsed.length > 0) reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
    await this.safeSend(ctx, reply);
  } catch (err) {
    console.error("Error handling photo:", err);
    await ctx.reply("Sorry, I couldn't process that image. Please try again.");
  }
});
```

**`message:text` handler:**
```typescript
bot.on("message:text", async (ctx) => {
  if (this.setupSessions.has(ctx.chat.id)) {
    await this.handleSetupReply(ctx);
    return;
  }
  const session = await this.ensureAuthenticated(ctx.chat.id);
  if (!session) {
    await ctx.reply("Please authenticate first. Use /auth <token>.");
    return;
  }
  await this.ensureUserProfile(session.userId, ctx.chat.id);
  const conversationId = this.conversations.get(ctx.chat.id);
  await ctx.replyWithChatAction("typing");
  try {
    const response = await this.assistantUseCase.chat({
      userId: session.userId,
      conversationId,
      message: ctx.message.text,
    });
    this.conversations.set(ctx.chat.id, response.conversationId);
    let reply = response.reply;
    if (response.toolsUsed.length > 0) reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
    await this.safeSend(ctx, reply);
  } catch (err) {
    console.error("Error handling message:", err);
    await ctx.reply("Sorry, something went wrong. Please try again.");
  }
});
```

**`/allow` and `/revoke` commands:** Delete entirely. Do not add replacements.

### 12h — Update `handleSetupReply` — wakeup phase

In the `wakeup` phase block of `handleSetupReply`, replace:
```typescript
const userId = this.resolveUserId(chatId);
```
with:
```typescript
const userId = session.userId;
```

The `session` object is already on `SetupSession` (added in step 12c). Access it as `session.userId`.

The full wakeup block becomes:
```typescript
if (session.phase.name === "wakeup") {
  const hour = parseInt(text ?? "", 10);
  if (Number.isNaN(hour) || hour < 0 || hour > 23) {
    await ctx.reply(
      "Please enter a number between 0 and 23 (e.g. *7* for 7 AM, *22* for 10 PM).",
      { parse_mode: "Markdown" },
    );
    return;
  }

  const userId = session.userId;
  await this.userProfileRepo.upsert({
    userId,
    personalities: session.collectedTraits,
    wakeUpHour: hour,
    telegramChatId: String(chatId),
  });

  session.phase = { name: "done" };
  this.setupSessions.delete(chatId);

  const authUrl = this.googleOAuthService.generateAuthUrl(userId);
  await ctx.reply(
    "Profile saved! JARVIS is now tuned to you.\n\nTap the button below to connect Google Calendar and Gmail.\n\nIf the redirect page doesn't load, copy the `code` from the URL and send `/code <value>` here.",
    {
      reply_markup: new InlineKeyboard().url("Connect Google", authUrl),
    },
  );
  return;
}
```

Note: `session` inside `handleSetupReply` refers to the `SetupSession` from `this.setupSessions.get(chatId)`, not the auth session.

**Guardrail:** After this step `resolveUserId` and `isAllowed` must not exist anywhere in `handler.ts`. The `uuidV5` import and `TELEGRAM_NS` constant must be gone. Search for them before moving on.

---

## Step 13 — Update `AssistantInject`

**File:** `src/adapters/inject/assistant.di.ts`

### 13a — Add imports
```typescript
import { AuthUseCaseImpl } from "../../use-cases/implementations/auth.usecase";
import { HttpApiServer } from "../implementations/input/http/httpServer";
import type { IAuthUseCase } from "../../use-cases/interface/input/auth.interface";
```

### 13b — Add private fields
```typescript
private _authUseCase: IAuthUseCase | null = null;
```

### 13c — Add `getAuthUseCase()` method
```typescript
getAuthUseCase(): IAuthUseCase {
  if (!this._authUseCase) {
    this._authUseCase = new AuthUseCaseImpl(
      this.getSqlDB().users,
      process.env.JWT_SECRET ?? "",
      process.env.JWT_EXPIRES_IN ?? "7d",
    );
  }
  return this._authUseCase;
}
```

### 13d — Add `getHttpApiServer()` method
```typescript
getHttpApiServer(): HttpApiServer {
  const port = parseInt(process.env.HTTP_API_PORT ?? "4000", 10);
  return new HttpApiServer(
    this.getAuthUseCase(),
    this.getGoogleOAuthService(),
    port,
  );
}
```

### 13e — Remove `allowedTelegramIds` from any remaining references
Search `assistant.di.ts` for `allowedTelegramIds`. If it appears anywhere (e.g., passed to `TelegramAssistantHandler`), remove it.

The `TelegramAssistantHandler` instantiation is in `telegramCli.ts`, not here. But if `AssistantInject` contains a helper that constructs the handler, update it. If not, skip.

---

## Step 14 — Update `telegramCli.ts`

**File:** `src/telegramCli.ts`

### 14a — Remove the standalone OAuth HTTP server
Delete the entire `http.createServer(...)` block and `oauthServer.listen(...)` and `oauthServer.close()` in the SIGINT handler. This functionality now lives in `HttpApiServer`.

### 14b — Remove OAuth-related imports
Delete `import http from "node:http"` and `import { URL } from "node:url"` (unless still needed elsewhere in the file after other changes).

### 14c — Add HTTP server startup
```typescript
const httpServer = inject.getHttpApiServer();
httpServer.start();
```

### 14d — Update `TelegramAssistantHandler` instantiation
Remove: `sqlDB.allowedTelegramIds`, `adminChatId`
Add: `inject.getAuthUseCase()`, `sqlDB.telegramSessions`

New instantiation:
```typescript
const handler = new TelegramAssistantHandler(
  useCase,
  sqlDB.userProfiles,
  googleOAuthService,
  tts,
  inject.getAuthUseCase(),
  sqlDB.telegramSessions,
  token,
);
```

### 14e — Remove `adminChatId` lines
Delete:
```typescript
const adminChatId = process.env.BOT_ADMIN_TELEGRAM_ID
  ? parseInt(process.env.BOT_ADMIN_TELEGRAM_ID, 10)
  : undefined;
```

### 14f — Add `httpServer.stop()` to SIGINT handler
```typescript
process.on("SIGINT", async () => {
  console.log("\nShutting down…");
  httpServer.stop();
  await bot.stop();
  process.exit(0);
});
```

---

## Step 15 — Update `.env.example`

**File:** `.env.example`

Remove:
```
BOT_ADMIN_TELEGRAM_ID=
```

Add:
```
# HTTP API server
HTTP_API_PORT=4000

# JWT — use a strong random secret (e.g. openssl rand -hex 32)
JWT_SECRET=
# Token lifetime — examples: 7d, 30d, 1h
JWT_EXPIRES_IN=7d
```

Also update the comment on `GOOGLE_REDIRECT_URI` to reflect it now points to `HTTP_API_PORT`:
```
# Must match the redirect URI registered in Google Cloud Console
# e.g. http://localhost:4000/api/auth/google/calendar/callback
GOOGLE_REDIRECT_URI=
```

Remove the `OAUTH_CALLBACK_PORT` line if it exists (the port is now `HTTP_API_PORT`).

---

## Step 16 — TypeScript Compile Check

```bash
npx tsc --noEmit
```

Fix every error. Common errors that will appear:
- `TelegramAssistantHandler` constructor argument mismatch — fix in `telegramCli.ts`
- `allowedTelegramIds` referenced somewhere — find and remove
- `DrizzleSqlDB` missing `telegramSessions` property or still has `allowedTelegramIds` — fix in `drizzleSqlDb.adapter.ts`
- `fullName` / `dob` referenced in `UserInit` consumers — fix at each call site
- `uuidV5` or `TELEGRAM_NS` still referenced — delete from `handler.ts`

Do not proceed until `tsc --noEmit` exits with zero errors.

---

## Step 17 — Manual Smoke Test Checklist

**Registration:**
1. `POST /auth/register` with `{ "email": "test@test.com", "password": "password123", "username": "testuser" }` → expect 201 `{ userId }`
2. `POST /auth/register` with same email → expect 409 `{ error: "Email already registered" }`
3. `POST /auth/register` with invalid email format → expect 400

**Login:**
4. `POST /auth/login` with correct credentials → expect 200 `{ token, expiresAtEpoch, userId }`
5. `POST /auth/login` with wrong password → expect 401 `{ error: "Invalid email or password" }`
6. `POST /auth/login` with unknown email → expect 401 (same error as wrong password)

**Telegram auth:**
7. Send a message to the bot without authenticating → expect "Please authenticate first."
8. `/auth <token>` with valid token → expect "Authenticated."
9. `/auth <token>` with expired/invalid token → expect "Invalid or expired token."
10. After authenticating, send a message → expect normal JARVIS response

**Telegram session persistence:**
11. Restart the process; send a message from a previously authenticated chatId → still authenticated (session loaded from DB)

**Google OAuth:**
12. `GET /auth/google` with valid bearer token → expect 200 `{ url }` pointing to Google consent screen
13. `GET /auth/google` without token → expect 401

---

## Files Changed Summary

| File | Change |
|------|--------|
| `src/adapters/implementations/output/sqlDB/schema.ts` | Drop `fullName`, `dob` from `users`; add unique on `email`; drop `allowedTelegramIds` table; add `telegramSessions` table |
| `src/use-cases/interface/output/repository/user.repo.ts` | Remove `fullName`, `dob`; add `findByEmail` to `IUserDB` |
| `src/adapters/implementations/output/sqlDB/repositories/user.repo.ts` | Remove `fullName`, `dob` from all methods; add `findByEmail`; remove `findByUsernameOrEmail` |
| `src/use-cases/interface/output/repository/allowedTelegramId.repo.ts` | **Delete** |
| `src/adapters/implementations/output/sqlDB/repositories/allowedTelegramId.repo.ts` | **Delete** |
| `src/use-cases/interface/output/repository/telegramSession.repo.ts` | **New file** — `ITelegramSessionDB` interface |
| `src/adapters/implementations/output/sqlDB/repositories/telegramSession.repo.ts` | **New file** — Drizzle implementation |
| `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` | Remove `allowedTelegramIds`; add `telegramSessions` |
| `src/use-cases/interface/input/auth.interface.ts` | **New file** — `IAuthUseCase` interface |
| `src/use-cases/implementations/auth.usecase.ts` | **New file** — `AuthUseCaseImpl` |
| `src/adapters/implementations/input/http/httpServer.ts` | **New file** — `HttpApiServer` |
| `src/adapters/implementations/input/telegram/handler.ts` | Remove allowlist + UUIDv5 logic; add `/auth`, session cache, `ensureAuthenticated` |
| `src/adapters/inject/assistant.di.ts` | Add `getAuthUseCase()`, `getHttpApiServer()` |
| `src/telegramCli.ts` | Remove standalone OAuth server; add `HttpApiServer`; update handler instantiation |
| `.env.example` | Replace `BOT_ADMIN_TELEGRAM_ID` + `OAUTH_CALLBACK_PORT` with `HTTP_API_PORT`, `JWT_SECRET`, `JWT_EXPIRES_IN` |

---

## What Stays Unchanged

- `src/use-cases/implementations/assistant.usecase.ts` — already accepts `userId` per request, no change needed
- All tool implementations — already accept `userId` in constructor
- `src/adapters/implementations/output/googleOAuth/googleOAuth.service.ts` — per-user token storage already correct
- All other repos — already query by `userId`
- `src/adapters/implementations/input/telegram/bot.ts` — no change needed
- Background crawlers (`calendarCrawler`, `dailySummaryCrawler`, `notificationRunner`) — no change needed
- DB schema tables other than `users` and the removed/added tables — no change needed
