# Telegram Bot Interface Plan

## Goal

Add a Telegram bot as a new **input adapter** so that any Telegram user can interact with JARVIS the same way the `consoleCli` does — sending text messages and receiving replies, with full tool usage and per-chat conversation continuity.

All existing use-case and output-adapter code remains untouched. This is purely a new input adapter.

---

## Architecture Overview

```
Telegram Layer                  Use Case Layer            (unchanged)
──────────────────────          ──────────────────────
TelegramBot                     IAssistantUseCase
  ↳ wraps grammy Bot              .chat(IChatInput)
  ↳ delegates to                  .listConversations()
    TelegramAssistantHandler      .getConversation()

TelegramAssistantHandler
  ↳ mirrors AssistantControllerConcrete
  ↳ holds IAssistantUseCase
  ↳ maps Telegram ctx → IChatInput
  ↳ maps IChatResponse → ctx.reply()

src/telegramCli.ts              AssistantInject (reused as-is)
  ↳ entry point                 DepInject (not used; bot has own DI)
  ↳ mirrors consoleCli.ts
```

Convention rules respected:
- New files live under `src/adapters/implementations/input/telegram/`
- Entry point at `src/telegramCli.ts` (matches `consoleCli.ts`, `jarvisCli.ts`, `userCli.ts`)
- DI wired inside the entry point via existing `AssistantInject` (no new DI class needed — same pattern as `consoleCli.ts`)
- No new use-case interfaces; the bot calls the same `IAssistantUseCase.chat()`
- TypeScript, no class decorators, no frameworks beyond the Telegram SDK

---

## Library Choice

**grammy** (`grammy` on npm) — TypeScript-first, lightweight, no class magic, well-maintained.

```
npm install grammy
npm install --save-dev @types/node   # already present
```

`grammy` exposes a `Bot` class and a `Context` type. No polling vs webhook switch needed at dev time — long-polling works out of the box.

---

## userId Mapping Strategy

The console CLI uses a single fixed `CLI_USER_ID`. For Telegram, each chat has a unique numeric `chat.id`. Two options:

**Option A — map Telegram chat ID to a deterministic UUID (chosen)**
Use a namespace UUID v5 derived from the Telegram chat ID string. This produces a stable, valid UUID per Telegram user with no database lookup needed.

```ts
import { v5 as uuidV5 } from "uuid";
const TELEGRAM_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // URL namespace
const userId = uuidV5(String(ctx.chat.id), TELEGRAM_NS);
```

This means no user registration required and the userId is reproducible across restarts.

**Option B — require `/start` to register** (deferred for future)
On `/start`, auto-create a row in the `users` table and store the mapping in Redis or DB. More correct long-term but out of scope here.

---

## Conversation State

Each Telegram chat maintains one active `conversationId` in memory (a `Map<chatId, conversationId>`). This mirrors what `consoleCli.ts` does with its `conversationId` local variable.

Commands that reset the conversation:
- `/new` — clears the stored `conversationId` so the next message starts fresh

---

## Supported Commands & Behaviours

| Input | Behaviour | Use-case method |
|---|---|---|
| Any text message | Send to JARVIS, reply with answer | `chat()` |
| `/start` | Welcome message, no LLM call | — |
| `/new` | Clear active conversation, confirm | — |
| `/history` | Fetch and display last N messages of current conversation | `getConversation()` |
| Voice message (future) | Transcribe + chat | `voiceChat()` — not in v1 |

All behaviours match the console CLI capabilities. `/history` adds something the CLI doesn't show, but it uses an existing use-case method.

---

## File Tree (new files only)

```
src/
  telegramCli.ts                                    ← entry point

  adapters/
    implementations/
      input/
        telegram/
          TelegramBot.ts                            ← grammy Bot wrapper (lifecycle: start/stop)
          assistantHandler.telegram.ts              ← maps Telegram messages → IAssistantUseCase
```

No changes to:
- `src/adapters/inject/` (TelegramBot constructs its own `AssistantInject` inline, same as `consoleCli.ts`)
- Any use-case, output adapter, schema, or migration

---

## Detailed File Specs

### `src/adapters/implementations/input/telegram/TelegramBot.ts`

```ts
import { Bot } from "grammy";
import type { TelegramAssistantHandler } from "./assistantHandler.telegram";

export class TelegramBot {
  private bot: Bot;

  constructor(token: string, handler: TelegramAssistantHandler) {
    this.bot = new Bot(token);
    handler.register(this.bot);
  }

  start(): void {
    this.bot.start();                   // long-polling, blocks async
  }

  stop(): Promise<void> {
    return this.bot.stop();
  }
}
```

`start()` launches grammy's built-in long-polling loop (no external webhook setup needed for development or self-hosted use). For production with webhook, this is swapped to `bot.init()` + `webhookCallback()` — out of scope for v1.

---

### `src/adapters/implementations/input/telegram/assistantHandler.telegram.ts`

```ts
import type { Bot } from "grammy";
import { v5 as uuidV5 } from "uuid";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";

const TELEGRAM_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

export class TelegramAssistantHandler {
  // In-memory conversation state per chat — same pattern as consoleCli.ts
  private conversations = new Map<number, string>();

  constructor(private readonly assistantUseCase: IAssistantUseCase) {}

  register(bot: Bot): void {
    bot.command("start", (ctx) => ctx.reply("JARVIS online. Send me a message."));

    bot.command("new", (ctx) => {
      this.conversations.delete(ctx.chat.id);
      return ctx.reply("Conversation reset. Starting fresh.");
    });

    bot.command("history", async (ctx) => {
      const conversationId = this.conversations.get(ctx.chat.id);
      if (!conversationId) {
        return ctx.reply("No active conversation yet. Send a message first.");
      }
      const userId = this.resolveUserId(ctx.chat.id);
      const messages = await this.assistantUseCase.getConversation({ userId, conversationId });
      // Format last 10 messages
      const text = messages
        .slice(-10)
        .map((m) => `${m.role === "user" ? "You" : "JARVIS"}: ${m.content}`)
        .join("\n\n");
      return ctx.reply(text || "No messages yet.");
    });

    bot.on("message:text", async (ctx) => {
      const userId = this.resolveUserId(ctx.chat.id);
      const conversationId = this.conversations.get(ctx.chat.id);

      await ctx.replyWithChatAction("typing");

      const response = await this.assistantUseCase.chat({
        userId,
        conversationId,
        message: ctx.message.text,
      });

      this.conversations.set(ctx.chat.id, response.conversationId);

      let reply = response.reply;
      if (response.toolsUsed.length > 0) {
        reply += `\n\n_[tools: ${response.toolsUsed.join(", ")}]_`;
      }

      return ctx.reply(reply, { parse_mode: "Markdown" });
    });
  }

  private resolveUserId(chatId: number): string {
    return uuidV5(String(chatId), TELEGRAM_NS);
  }
}
```

Error handling: wrap the `message:text` handler in try/catch; on failure, reply with a generic error message and log to stderr — matching the `consoleCli.ts` pattern.

---

### `src/telegramCli.ts`

```ts
import "dotenv/config";
import { AssistantInject } from "./adapters/inject/assistant.di";
import { TelegramBot } from "./adapters/implementations/input/telegram/TelegramBot";
import { TelegramAssistantHandler } from "./adapters/implementations/input/telegram/assistantHandler.telegram";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set.");
  process.exit(1);
}

const inject = new AssistantInject();
const useCase = inject.getUseCase();

const handler = new TelegramAssistantHandler(useCase);
const bot = new TelegramBot(token, handler);

console.log("JARVIS Telegram bot starting…");

process.on("SIGINT", async () => {
  console.log("\nShutting down…");
  await bot.stop();
  process.exit(0);
});

bot.start();
```

Same shape as `consoleCli.ts`: import `dotenv/config`, create `AssistantInject`, call use case, run.

---

## package.json additions

```json
"scripts": {
  "telegram": "ts-node src/telegramCli.ts"
}
```

```json
"dependencies": {
  "grammy": "^1.x"
}
```

---

## Environment Variables

Add to `.env`:

```
TELEGRAM_BOT_TOKEN=<token from @BotFather>
```

No other new env vars needed. All existing vars (`OPENAI_API_KEY`, `REDIS_URL`, etc.) are reused as-is since `AssistantInject` is shared.

---

## Implementation Order

1. `npm install grammy`
2. Add `TELEGRAM_BOT_TOKEN` to `.env`
3. Create `src/adapters/implementations/input/telegram/assistantHandler.telegram.ts`
4. Create `src/adapters/implementations/input/telegram/TelegramBot.ts`
5. Create `src/telegramCli.ts`
6. Add `"telegram"` script to `package.json`
7. Run `npm run telegram` and test via Telegram

---

## What is NOT in scope (v1)

- User registration / linking Telegram account to existing DB user
- Voice messages (the `voiceChat()` path exists but Telegram voice requires downloading the file + passing buffer — deferred)
- Webhook mode (long-polling is sufficient for self-hosted; webhook is a config-only change in grammy)
- Inline keyboards or rich formatting beyond Markdown italics for tool labels
- Rate limiting per chat
