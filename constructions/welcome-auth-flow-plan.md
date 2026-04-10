# Welcome + Auth Onboarding Flow — Implementation Plan

> Date: 2026-04-10  
> Status: Draft  
> Touches: `handler.ts`, `assistant.di.ts`, `telegramCli.ts`, `.env.example`

---

## Goal

When an unauthenticated user arrives at the bot, replace the current plain-text instruction message with a rich welcome screen and two inline keyboard buttons: **Login** and **Register**. Clicking a button returns a ready-to-use `curl` command with blank placeholders. After the user runs the curl and obtains a JWT, the existing `/auth <token>` flow takes over unchanged.

---

## Current behaviour (to replace)

`/start` while unauthenticated → plain text:
```
Welcome to the Onchain Agent.

Authenticate first: call POST /auth/login to get a token, then send /auth <token> here.
```

Any other command or message while unauthenticated → "Please authenticate first. Use /auth <token>."

---

## Target behaviour

### Step 1 — `/start` (unauthenticated)

Bot sends **one** message containing:

```
Welcome to the Onchain Agent.

You need an account to interact with the agent.
Choose an option below to get started.
```

Followed by an inline keyboard:

```
[ Login ]   [ Register ]
```

### Step 2 — User clicks "Login"

Bot answers the callback query silently (no alert), then sends:

```
To log in, run the following curl command in your terminal.
Replace <email> and <password> with your credentials:

```curl
curl -X POST ${HTTP_API_BASE_URL}/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<email>","password":"<password>"}'
```

You will receive a JSON response with a `token` field.
Send it here with: /auth <token>
```

### Step 3 — User clicks "Register"

Bot answers the callback query silently, then sends:

```
To create an account, run the following curl command.
Replace the placeholders with your details:

```curl
curl -X POST ${HTTP_API_BASE_URL}/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"<email>","password":"<password>","username":"<username>"}'
```

Registration deploys your Smart Contract Account and returns `{ "userId": "..." }`.
After registration, log in with the login curl to get your token, then send: /auth <token>
```

### Step 4 — `/auth <token>` (unchanged)

Existing flow: validates token via `IAuthUseCase.validateToken`, upserts `telegram_sessions`, sets cache, replies "Authenticated."

---

## New environment variable

| Variable           | Required | Purpose                                        |
| ------------------ | -------- | ---------------------------------------------- |
| `HTTP_API_BASE_URL`| Yes      | Base URL shown in curl commands, e.g. `http://localhost:4000` |

This is the only new env var. It must be passed from the DI layer, never read directly inside `handler.ts`.

---

## Architecture & file changes

### 1. `src/adapters/implementations/input/telegram/handler.ts`

**Constructor — add one new optional param** (keep all existing params in position, append at the end):

```typescript
constructor(
  // … all existing params in their current order …
  private readonly apiBaseUrl?: string,   // <-- NEW, last position
) {}
```

**`register(bot)` — three changes:**

#### a. Import `InlineKeyboard` from `grammy`

Add to the import at the top of the file (grammy is already a dependency):

```typescript
import { InlineKeyboard } from "grammy";
```

#### b. Replace the unauthenticated branch of the `start` command handler

```typescript
bot.command("start", async (ctx) => {
  const session = await this.ensureAuthenticated(ctx.chat.id);
  if (!session) {
    const keyboard = new InlineKeyboard()
      .text("Login", "auth:login")
      .text("Register", "auth:register");
    await ctx.reply(
      "Welcome to the Onchain Agent.\n\nYou need an account to interact with the agent.\nChoose an option below to get started.",
      { reply_markup: keyboard },
    );
    return;
  }
  await ctx.reply("Onchain Agent online. Describe what you'd like to do on-chain.");
});
```

#### c. Add callback query handlers (append inside `register`, before the `message:text` handler)

```typescript
bot.callbackQuery("auth:login", async (ctx) => {
  await ctx.answerCallbackQuery();
  const base = this.apiBaseUrl ?? "";
  await ctx.reply(
    `To log in, run the following curl command in your terminal.\nReplace <email> and <password> with your credentials:\n\n\`\`\`bash\ncurl -X POST ${base}/auth/login \\\\\n  -H "Content-Type: application/json" \\\\\n  -d '{"email":"<email>","password":"<password>"}'\n\`\`\`\n\nYou will receive a JSON response with a \`token\` field.\nSend it here with: /auth <token>`,
    { parse_mode: "Markdown" },
  );
});

bot.callbackQuery("auth:register", async (ctx) => {
  await ctx.answerCallbackQuery();
  const base = this.apiBaseUrl ?? "";
  await ctx.reply(
    `To create an account, run the following curl command.\nReplace the placeholders with your details:\n\n\`\`\`bash\ncurl -X POST ${base}/auth/register \\\\\n  -H "Content-Type: application/json" \\\\\n  -d '{"email":"<email>","password":"<password>","username":"<username>"}'\n\`\`\`\n\nRegistration deploys your Smart Contract Account and returns \`{ "userId": "..." }\`.\nAfter registration, log in with the login curl to get your token, then send: /auth <token>`,
    { parse_mode: "Markdown" },
  );
});
```

**No other methods change.** `ensureAuthenticated`, `handleFallbackChat`, `startTokenResolution`, and all intent-path methods are untouched.

---

### 2. `src/adapters/inject/assistant.di.ts`

Read the env var once and pass it as the new last arg to `TelegramAssistantHandler`:

```typescript
const apiBaseUrl = process.env.HTTP_API_BASE_URL;

// Inside getAssistantHandler() (or wherever TelegramAssistantHandler is instantiated):
return new TelegramAssistantHandler(
  assistantUseCase,
  authUseCase,
  telegramSessions,
  process.env.TELEGRAM_BOT_TOKEN,
  intentUseCase,
  userProfileDB,
  tokenRegistryService,
  viemClient,
  chainId,
  intentParser,
  toolManifestDB,
  toolIndexService,
  apiBaseUrl,          // <-- NEW last arg
);
```

No other DI changes needed.

---

### 3. `src/telegramCli.ts`

No changes needed. `HTTP_API_BASE_URL` is read inside `assistant.di.ts`, not the entry point.

---

### 4. `.env.example` (or equivalent)

Add the new variable with a sensible default comment:

```dotenv
# Base URL of the HTTP API — shown in Telegram curl instructions
HTTP_API_BASE_URL=http://localhost:4000
```

---

## Guardrails & safety checklist

### No hardcoded values

- The API URL is sourced exclusively from `HTTP_API_BASE_URL` env var.
- `apiBaseUrl` is `undefined` if the env var is absent — the curl snippet will show `/auth/login` without a host (obvious to the user that they must set the var). No silent fallback to `localhost`.
- Callback data strings (`auth:login`, `auth:register`) are constants scoped to this file; they are not user-controlled inputs.

### No architecture leakage

- `handler.ts` never reads `process.env` directly. All config arrives via constructor params (existing convention: `botToken` is already passed this way).
- The inline keyboard logic stays inside the driving adapter layer (`telegram/`). No use-case, port, or domain type is touched.
- No new ports or interfaces are needed; this is purely a Telegram UI concern.

### No codebase convention violations

- Constructor params follow the existing positional pattern; the new param is last and optional (`?`) so existing call sites in tests or other files do not break.
- `InlineKeyboard` is from the already-declared `grammy` dependency — no new packages.
- `ctx.answerCallbackQuery()` is called **before** any reply, satisfying Telegram's 30-second callback answer deadline and preventing "spinning" buttons in the UI.
- No JSDoc or extra comments added per project conventions.

### Callback query security

- Callback data is a fixed short string, not user-supplied; there is no injection vector.
- Unauthenticated users CAN trigger the callback query handlers. This is intentional — the handlers only return a curl snippet (read-only, no state mutation).
- Authenticated users who somehow click the inline button again: `ctx.answerCallbackQuery()` is called, curl is shown again. Harmless and idempotent.
- Old messages with the inline keyboard remain in chat after the user authenticates. Clicking them again just shows the curl. No risk.

### No state mutation on unauthenticated path

- The `start` command unauthenticated branch returns immediately after sending the keyboard — no session cache writes, no DB calls.
- Callback handlers do not touch `sessionCache`, `conversations`, `intentHistory`, or `tokenDisambiguation`.

### Markdown safety

- The curl snippet is sent with `parse_mode: "Markdown"`. Backtick code blocks are safe for curl text. No user-supplied strings are interpolated into the Markdown.
- `apiBaseUrl` is env-sourced, not user-sourced, but it is still interpolated into Markdown. To prevent any accidental Markdown breakage, the env var should be a plain URL (no backticks or underscores). Document this expectation in `.env.example`.

---

## No-change surface

The following are explicitly untouched by this plan:

- All use-case interfaces and implementations
- All repository interfaces and Drizzle implementations
- The HTTP API server
- The `/auth <token>` command handler logic
- All intent parsing, token disambiguation, and solver paths
- The database schema — no new tables or columns
- The DI container beyond passing one new env var

---

## Implementation order

1. Add `HTTP_API_BASE_URL` to `.env.example`.
2. Update `TelegramAssistantHandler` constructor signature (`apiBaseUrl?: string` last).
3. Add `import { InlineKeyboard } from "grammy"` to `handler.ts`.
4. Replace the unauthenticated `/start` branch with the inline keyboard variant.
5. Add the two `bot.callbackQuery` handlers inside `register()`.
6. Update `assistant.di.ts` to read `HTTP_API_BASE_URL` and pass it to the constructor.
7. Manually test: `/start` unauthenticated → buttons appear → click Login → curl shown → click Register → curl shown → run curl → get token → `/auth <token>` → authenticated message.
