# P2P ERC20 Transfer via Telegram Handle — Implementation Plan

> Feature: "Send 5 RON to @rye-ndt" — detect a Telegram handle, resolve it to an EVM address via MTProto + Privy, auto-fill the recipient, execute the transfer, and notify the recipient.

---

## Overview

The flow is an extension of the existing `SEND_TOKEN` orchestrator path already wired in `handler.ts`. The key addition is a **three-step resolution pipeline** that happens transparently between schema compilation and token resolution:

```
User: "send 5 RON to @rye-ndt"
         │
         ▼
[1] OpenAISchemaCompiler detects @handle → CompileResult.telegramHandle = "rye-ndt"
         │
         ▼
[2] GramjsTelegramResolver.resolveHandle("rye-ndt")
        → MTProto contacts.resolveUsername → telegramUserId = "123858152873"
         │
         ▼
[3] PrivyServerAuthAdapter.getOrCreateWalletByTelegramId("123858152873")
        → Privy getUserByTelegramUserId or create new embedded wallet
        → recipientAddress = "0xabc..."
         │
         ▼
[4] Inject recipientAddress into partialParams.recipient (auto-filled, not asked)
    Store telegramUserId in pendingRecipientNotifications map
         │
         ▼
[5] Normal flow: token resolve → confirmation → /confirm → execute
         │
         ▼
[6] After execution: notify recipient via bot.api.sendMessage (best-effort)
```

---

## Files to create

### `src/use-cases/interface/output/telegramResolver.interface.ts`
New port — decouples the handler from gramjs.

```typescript
export interface ITelegramHandleResolver {
  /**
   * Resolves a public Telegram username to a numeric user ID string.
   * Throws TelegramHandleNotFoundError if the username does not exist or is private.
   */
  resolveHandle(username: string): Promise<string>;
}

export class TelegramHandleNotFoundError extends Error {
  constructor(handle: string, cause?: string) {
    super(`Could not resolve Telegram handle @${handle}${cause ? `: ${cause}` : ""}`);
    this.name = "TelegramHandleNotFoundError";
  }
}
```

---

### `src/adapters/implementations/output/telegram/gramjs.telegramResolver.ts`
Adapter — wraps the `telegram` (gramjs) MTProto client.

**Key points:**
- Needs `TG_API_ID` (number), `TG_API_HASH` (string), `TELEGRAM_BOT_TOKEN` (already exists), `TG_SESSION` (string, empty initially).
- Authenticates as a **bot** using `client.start({ botAuthToken })` — no user account needed.
- On first boot, logs `client.session.save()` so you can persist `TG_SESSION`.
- The `telegram` package must be added: `npm install telegram`.

```typescript
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import type { ITelegramHandleResolver } from "../../../../use-cases/interface/output/telegramResolver.interface";
import { TelegramHandleNotFoundError } from "../../../../use-cases/interface/output/telegramResolver.interface";

export class GramjsTelegramResolver implements ITelegramHandleResolver {
  private client: TelegramClient;
  private connected = false;

  constructor(apiId: number, apiHash: string, botToken: string, session: string) {
    this.client = new TelegramClient(
      new StringSession(session),
      apiId,
      apiHash,
      { connectionRetries: 3 },
    );
    // Auth is done lazily on first call, or eagerly via connect()
    void this.connect(botToken);
  }

  private async connect(botToken: string): Promise<void> {
    if (this.connected) return;
    await this.client.start({ botAuthToken: botToken });
    this.connected = true;
    console.log("[GramjsTelegramResolver] connected. Session:", this.client.session.save());
  }

  async resolveHandle(username: string): Promise<string> {
    const clean = username.replace(/^@/, "");
    try {
      const result = await this.client.invoke(
        new Api.contacts.resolveUsername({ username: clean }),
      );
      const user = result.users[0] as Api.User | undefined;
      if (!user?.id) {
        throw new TelegramHandleNotFoundError(username, "no user in response");
      }
      return user.id.toString();
    } catch (err) {
      if (err instanceof TelegramHandleNotFoundError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // Common MTProto error codes:
      // USERNAME_NOT_OCCUPIED — handle doesn't exist
      // USERNAME_INVALID     — invalid format
      // FLOOD_WAIT_X         — rate limit
      console.error(`[GramjsTelegramResolver] resolveHandle failed for @${username}:`, msg);
      throw new TelegramHandleNotFoundError(username, msg);
    }
  }
}
```

---

## Files to modify

### 1. `src/use-cases/interface/output/schemaCompiler.interface.ts`

Add `telegramHandle?: string` to `CompileResult`:

```typescript
export interface CompileResult {
  params: Record<string, unknown>;
  missingQuestion: string | null;
  tokenSymbols: { from?: string; to?: string };
  telegramHandle?: string;  // ← NEW: e.g. "rye-ndt" (without @), if user mentions a person handle
}
```

---

### 2. `src/adapters/implementations/output/intentParser/openai.schemaCompiler.ts`

Extend `CompileSchema` and the system prompt to detect handles.

**Change 1 — extend Zod schema:**
```typescript
const CompileSchema = z.object({
  paramsJson: z.string(),
  missingQuestion: z.string().nullable(),
  fromTokenSymbol: z.string().nullable(),
  toTokenSymbol: z.string().nullable(),
  telegramHandle: z.string().nullable(),  // ← NEW
});
```

**Change 2 — extend system prompt** (append to the Instructions block):
```
- If the user mentions a Telegram handle as the recipient (a word starting with @
  followed by alphanumerics/underscores, referring to a *person*, not a protocol,
  token name, or brand), extract it into telegramHandle without the @ prefix (e.g.
  "rye-ndt"). Only set this when the intent is to send tokens TO that specific
  person. If no person handle is mentioned, set telegramHandle to null.
```

**Change 3 — propagate to result:**
```typescript
return {
  params,
  missingQuestion: parsed.missingQuestion,
  tokenSymbols,
  telegramHandle: parsed.telegramHandle ?? undefined,  // ← NEW
};
```

---

### 3. `src/use-cases/interface/output/privyAuth.interface.ts`

Add `getOrCreateWalletByTelegramId` to the interface:

```typescript
export interface IPrivyAuthService {
  verifyToken(accessToken: string): Promise<PrivyVerifiedUser>;
  getOrCreateWalletByTelegramId(telegramUserId: string): Promise<string>; // ← NEW: returns 0x address
}
```

---

### 4. `src/adapters/implementations/output/privyAuth/privyServer.adapter.ts`

Implement the new method. Uses the exact get-or-create pattern from the brief:

```typescript
async getOrCreateWalletByTelegramId(telegramUserId: string): Promise<string> {
  let user: Awaited<ReturnType<PrivyClient["getUserByTelegramUserId"]>>;

  try {
    user = await this.client.getUserByTelegramUserId(telegramUserId);
    console.log(`[Privy] found existing user for telegramUserId=${telegramUserId}`);
  } catch {
    console.log(`[Privy] no existing user for telegramUserId=${telegramUserId}, creating...`);
    user = await (this.client.users() as any).create({
      linked_accounts: [
        { type: "telegram", telegram_user_id: telegramUserId },
      ],
    });
  }

  const embeddedWallet = user.linkedAccounts.find(
    (a) => a.type === "wallet" && (a as any).walletClientType === "privy",
  );

  if (!embeddedWallet || !("address" in embeddedWallet)) {
    throw new Error(
      `[Privy] No embedded wallet for telegramUserId=${telegramUserId}. ` +
      "Ensure embedded wallet creation is enabled in your Privy dashboard.",
    );
  }

  return (embeddedWallet as { address: string }).address;
}
```

> **Note:** The exact shape of the Privy SDK types for `users().create()` may need to be confirmed against the installed version of `@privy-io/server-auth`. If the method signature differs, adjust accordingly — the logic is the same.

---

### 5. `src/adapters/implementations/input/telegram/handler.ts`

This is the main integration point. Four changes:

**Change 1 — extend `OrchestratorSession`** to carry the resolved recipient Telegram user ID:
```typescript
interface OrchestratorSession {
  // ... existing fields ...
  recipientTelegramUserId?: string;  // ← NEW
}
```

**Change 2 — add imports + constructor params** (`ITelegramHandleResolver`, `IPrivyAuthService`, `bot` reference for notifications):
```typescript
import type { ITelegramHandleResolver } from "../../../../use-cases/interface/output/telegramResolver.interface";
import { TelegramHandleNotFoundError } from "../../../../use-cases/interface/output/telegramResolver.interface";

// In constructor:
private readonly telegramHandleResolver?: ITelegramHandleResolver,
private readonly privyAuthService?: IPrivyAuthService,

// New map for post-confirm notifications:
private pendingRecipientNotifications = new Map<string, { telegramUserId: string }>();
// Also need a bot reference for sending messages:
private bot?: Bot;
```

The `bot` reference is set when `register(bot)` is called — add `this.bot = bot` at the top of `register()`.

**Change 3 — resolve handle after compileSchema**, inside `bot.on("message:text")`, right after building `newSession` and before calling `finishCompileOrAsk`:

```typescript
// After: const newSession = { ... }
// Before: if (compileResult.missingQuestion) { ... }

if (compileResult.telegramHandle) {
  const resolved = await this.resolveRecipientHandle(
    ctx,
    chatId,
    compileResult.telegramHandle,
    newSession,
  );
  if (!resolved) return; // error already replied, session cleared
}
```

Same hook applies in the **compile continuation block** (`existing.stage === "compile"`), after merging `compileResult.params` and before `finishCompileOrAsk`.

**Change 4 — new private method `resolveRecipientHandle`**:

```typescript
private async resolveRecipientHandle(
  ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
  chatId: number,
  handle: string,
  session: OrchestratorSession,
): Promise<boolean> {
  if (!this.telegramHandleResolver || !this.privyAuthService) {
    await ctx.reply("Sorry, peer-to-peer transfers are not configured on this server.");
    this.orchestratorSessions.delete(chatId);
    return false;
  }

  let telegramUserId: string;
  try {
    telegramUserId = await this.telegramHandleResolver.resolveHandle(handle);
    console.log(`[Handler] resolved @${handle} → telegramUserId=${telegramUserId}`);
  } catch (err) {
    const isNotFound = err instanceof TelegramHandleNotFoundError;
    const msg = isNotFound
      ? `Sorry, I couldn't find a Telegram user for @${handle}. Double-check the handle and try again.`
      : `Sorry, something went wrong resolving @${handle}. Please try again.`;
    if (!isNotFound) console.error(`[Handler] resolveHandle error for @${handle}:`, err);
    this.orchestratorSessions.delete(chatId);
    await ctx.reply(msg);
    return false;
  }

  let recipientAddress: string;
  try {
    recipientAddress = await this.privyAuthService.getOrCreateWalletByTelegramId(telegramUserId);
    console.log(`[Handler] resolved telegramUserId=${telegramUserId} → wallet=${recipientAddress}`);
  } catch (err) {
    console.error(`[Handler] Privy wallet resolution failed for telegramUserId=${telegramUserId}:`, err);
    this.orchestratorSessions.delete(chatId);
    await ctx.reply(
      `Sorry, I couldn't set up a wallet for @${handle}. Please try again later.`,
    );
    return false;
  }

  // Inject into params so the schema compiler / address-field extractor sees it
  session.partialParams.recipient = recipientAddress;
  session.recipientTelegramUserId = telegramUserId;
  return true;
}
```

**Change 5 — send recipient notification** in `/confirm` command handler, after `confirmLatestIntent` succeeds:

```typescript
bot.command("confirm", async (ctx) => {
  // ... existing auth check ...
  await ctx.replyWithChatAction("typing");
  try {
    const result = await this.confirmLatestIntent(session.userId);
    await this.safeSend(ctx, result);

    // NEW: notify recipient if this was a P2P transfer
    const pending = this.pendingRecipientNotifications.get(session.userId);
    if (pending) {
      this.pendingRecipientNotifications.delete(session.userId);
      await this.notifyRecipient(pending.telegramUserId, session.userId);
    }
  } catch (err) { ... }
});
```

**Change 6 — store pending notification** at the end of `buildAndShowConfirmation`, before the method returns:

```typescript
if (session.recipientTelegramUserId) {
  this.pendingRecipientNotifications.set(userId, {
    telegramUserId: session.recipientTelegramUserId,
  });
}
```

**Change 7 — new private method `notifyRecipient`**:

```typescript
private async notifyRecipient(
  recipientTelegramUserId: string,
  senderUserId: string,
): Promise<void> {
  if (!this.bot) return;
  try {
    // The recipient's Telegram chat ID equals their user ID for DMs
    await this.bot.api.sendMessage(
      parseInt(recipientTelegramUserId, 10),
      "You have received tokens in your wallet! Open the Aegis app to view your balance.",
    );
    console.log(`[Handler] notified recipient telegramUserId=${recipientTelegramUserId}`);
  } catch (err) {
    // Recipient hasn't started the bot — that's fine, best-effort only
    console.warn(
      `[Handler] could not notify recipient telegramUserId=${recipientTelegramUserId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
```

---

### 6. `src/adapters/inject/assistant.di.ts`

**Change 1 — add `GramjsTelegramResolver` singleton:**
```typescript
private _telegramHandleResolver: GramjsTelegramResolver | null = null;

getTelegramHandleResolver(): GramjsTelegramResolver | undefined {
  const apiId = parseInt(process.env.TG_API_ID ?? "", 10);
  const apiHash = process.env.TG_API_HASH;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!apiId || !apiHash || !botToken) return undefined;
  if (!this._telegramHandleResolver) {
    this._telegramHandleResolver = new GramjsTelegramResolver(
      apiId,
      apiHash,
      botToken,
      process.env.TG_SESSION ?? "",
    );
  }
  return this._telegramHandleResolver;
}
```

**Change 2 — pass to `TelegramAssistantHandler`** wherever it is constructed (in `telegramCli.ts` or wherever the handler is instantiated — trace the boot file):
```typescript
new TelegramAssistantHandler(
  // ... existing args ...
  inject.getTelegramHandleResolver(),
  inject.getPrivyAuthService(),
)
```

---

## New environment variables

| Variable | Purpose | Required |
|---|---|---|
| `TG_API_ID` | Telegram MTProto app ID (from my.telegram.org/apps) | Yes, for P2P |
| `TG_API_HASH` | Telegram MTProto app hash | Yes, for P2P |
| `TG_SESSION` | Saved gramjs StringSession (log on first boot) | Recommended |

`TELEGRAM_BOT_TOKEN` is already present and reused for bot authentication.

---

## New npm dependency

```bash
npm install telegram
```

gramjs (`telegram` on npm) — MTProto client for Node.js. Provides `TelegramClient` and `Api.contacts.resolveUsername`.

---

## Error handling matrix

| Failure point | User-facing message | Log level |
|---|---|---|
| `@handle` not found (USERNAME_NOT_OCCUPIED) | "Sorry, I couldn't find a Telegram user for @{handle}. Double-check the handle and try again." | warn |
| MTProto other error (FLOOD_WAIT, network) | "Sorry, something went wrong resolving @{handle}. Please try again." | error |
| Privy wallet creation fails (dashboard not configured) | "Sorry, I couldn't set up a wallet for @{handle}. Please try again later." | error |
| Resolver not configured (missing env vars) | "Sorry, peer-to-peer transfers are not configured on this server." | — |
| Recipient hasn't started the bot (notification fails) | *(no reply to sender — silent best-effort)* | warn |

---

## Clarifications / assumptions

1. **Handle detection is LLM-driven** — The schema compiler's LLM decides whether `@foo` is a person handle vs. a protocol/token name. The prompt explicitly instructs it to discriminate. Edge cases (e.g. `@TraderJoe`) may misfire; that's acceptable for v1.
2. **Only one handle per message** — If the user says "send to @alice and @bob", only the first extracted handle is used. Multi-recipient is out of scope.
3. **Recipient notification is best-effort** — If the recipient hasn't started the bot, the DM silently fails (not a blocking error for the sender's flow).
4. **`recipient` field naming** — The plan assumes the ERC20 transfer tool manifest has a field named `recipient` that accepts an EVM address. Confirm the actual field name from the registered tool manifest; adjust `session.partialParams.recipient = ...` accordingly.
5. **MTProto client lifecycle** — The `GramjsTelegramResolver` connects eagerly in its constructor and keeps the connection alive. It does not close/reopen per-request, which is the correct pattern for a long-running bot.
6. **`TG_SESSION` persistence** — On first boot with an empty session, gramjs will authenticate and print the session string. Copy it into your `.env` as `TG_SESSION` to avoid re-auth on restart.
