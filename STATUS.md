# JARVIS — Status

> Last updated: 2026-04-03 (multi-user feature)

---

## What it is

A multi-user AI assistant built in TypeScript with Hexagonal Architecture. Users send messages via Telegram; JARVIS reasons over conversation history, calls tools as needed, and returns a reply. Access is controlled by an allowlist — only users added by the admin can interact with the bot. Every component is behind an interface so adapters are swappable without touching business logic.

---

## Tech stack

| Layer          | Choice                                         |
| -------------- | ---------------------------------------------- |
| Language       | TypeScript 5.3, Node.js, strict mode           |
| Interface      | Telegram (`grammy`)                            |
| ORM            | Drizzle ORM + PostgreSQL (`pg` driver)         |
| Config cache   | Redis (`ioredis`) — JarvisConfig system prompt |
| LLM            | OpenAI chat completions + tool use (`gpt-4o`) — usage tokens surfaced |
| Text-to-speech | OpenAI TTS `tts-1`, opus/ogg format            |
| Speech-to-text | OpenAI Whisper `whisper-1` [working]            |
| Vision         | OpenAI gpt-4o vision (base64 data URL)         |
| Validation     | Zod 4.3.6                                      |
| DI             | Manual container in `src/adapters/inject/`     |
| Vector DB      | Pinecone (`@pinecone-database/pinecone`)       |
| Web search     | Tavily (`@tavily/core`)                        |

---

## Architecture

Hexagonal (Ports & Adapters). Use cases depend only on interfaces; adapters never depend on each other; DI wiring lives entirely in `src/adapters/inject/`.

---

## Project structure

```
src/
├── telegramCli.ts              # Entry point (npm run dev)
│
├── use-cases/
│   ├── implementations/
│   │   └── assistant.usecase.ts    # chat(), voiceChat(), listConversations(), getConversation()
│   └── interface/
│       ├── input/                  # Inbound ports: IAssistantUseCase
│       └── output/                 # Outbound ports: ISpeechToText, ILLMOrchestrator,
│                                   # ITool, IToolRegistry, IConversationDB,
│                                   # IMessageDB, IUserDB, IJarvisConfigDB, IUserMemoryDB,
│                                   # ITodoItemDB, ICalendarService, IGmailService,
│                                   # IEmbeddingService, IVectorStore, ITextGenerator,
│                                   # IEvaluationLogDB
│                                   # (IOrchestratorMessage now carries imageBase64Url)
│
├── adapters/
│   ├── inject/
│   │   └── assistant.di.ts        # Wires all components; getSqlDB(), getUseCase()
│   │
│   └── implementations/
│       ├── input/
│       │   └── telegram/          # TelegramBot, TelegramAssistantHandler
│       │                          # handles text + photo messages
│       │
│       └── output/
│           ├── orchestrator/      # OpenAIOrchestrator [working] — vision-capable
│           ├── stt/               # WhisperSpeechToText [working] — whisper-1, ogg input
│           ├── textToSpeech/      # OpenAITTS [working] — tts-1, opus/ogg
│           ├── calendar/          # GoogleCalendarService [working]
│           ├── mail/              # GoogleGmailService [working]
│           ├── embedding/         # OpenAIEmbeddingService [working]
│           ├── vectorDB/          # PineconeVectorStore [working]
│           ├── textGenerator/     # OpenAITextGenerator [working]
│           ├── googleOAuth/       # GoogleOAuthService [working]
│           ├── tools/
│           │   ├── calendarRead.tool.ts       # [working]
│           │   ├── calendarWrite.tool.ts      # [working]
│           │   ├── gmailSearchEmails.tool.ts  # [working]
│           │   ├── gmailCreateDraft.tool.ts   # [working]
│           │   ├── storeUserMemory.tool.ts    # [working]
│           │   ├── retrieveUserMemory.tool.ts # [working]
│           │   ├── createTodoItem.ts          # [working]
│           │   ├── retrieveTodoItems.ts       # [working]
│           │   └── webSearch.tool.ts          # [working] — Tavily
│           ├── toolRegistry.concrete.ts       # [working]
│           ├── jarvisConfig/      # CachedJarvisConfigRepo (Redis + DB) [working]
│           ├── reminder/          # CalendarCrawler, DailySummaryCrawler, NotificationRunner [working]
│           └── sqlDB/             # DrizzleSqlDB + all repos [working] — adds evaluationLogs, scheduledNotifications
│
└── helpers/
    ├── enums/
    │   ├── toolType.enum.ts
    │   ├── messageRole.enum.ts
    │   ├── statuses.enum.ts
    │   ├── personalities.enum.ts
    │   └── jarvisConfig.enum.ts
    ├── errors/
    │   ├── calendarNotConnected.error.ts
    │   └── gmailNotConnected.error.ts
    ├── time/dateTime.ts
    └── uuid.ts
```

---

## Conversation flow

### Commands

| Command    | Behavior |
| ---------- | -------- |
| `/start`   | Welcome message, hints at `/setup` |
| `/new`     | Clears active conversation ID (starts fresh) |
| `/history` | Replies with last 10 messages of the current conversation |
| `/setup`   | Launches 6-question personality quiz (a/b inline), then asks wake-up hour, saves `user_profiles`, presents Google OAuth link via InlineKeyboard |
| `/allow <chatId>` | Admin only — adds a Telegram chat ID to `allowed_telegram_ids` |
| `/revoke <chatId>` | Admin only — removes a Telegram chat ID from `allowed_telegram_ids` |
| `/code <auth_code>` | Exchanges a Google OAuth authorization code for tokens, stored in `google_oauth_tokens` |
| `/speech <message>` | Sends message through `chat()`, synthesizes the reply via `OpenAITTS`, returns an OGG voice message; falls back to text if TTS fails |
| _(voice message)_ | Download OGG from Telegram → Whisper transcription → `voiceChat()` → TTS reply as voice; falls back to text if TTS fails |
| _(photo message)_ | Download highest-res PhotoSize → base64 data URL → `chat()` with vision input |

### Normal message flow

```
Telegram message (text or photo)
      │
      ▼
TelegramAssistantHandler.on("message:text" | "message:photo")
  → isAllowed(chatId) — checks allowed_telegram_ids; rejects with "not authorized" if not found
  → resolveUserId(chatId) — UUIDv5(chatId, TELEGRAM_NS)
  → ensureUserProfile(userId, chatId) — creates/backfills user_profiles row if needed
  photo path: download highest-res PhotoSize → base64 data URL
      │
      ▼
AssistantUseCaseImpl.chat()
  1. Create conversation if new → IConversationDB
  2. Parallel batch (all concurrent):
       - findByConversationId (prior history only — user INSERT not yet visible)
       - searchRelevantMemories (embed query → Pinecone, score ≥ 0.75)
       - jarvisConfigRepo.get() (Redis → DB)
       - userProfileRepo.findByUserId()
       - conversationRepo.findById()
       - messageRepo.create() (persists user message)
  3. Compression check: if uncompressed token estimate > 80k OR flaggedForCompression
       - summarise oldest messages via ITextGenerator (gpt-4o-mini)
       - upsertSummary + markCompressed (concurrent)
       - sliding window = tail 20 uncompressed messages
  4. Build sliding window: [summary message?] + buildOrchestratorHistory(recentMessages)
  5. Build system prompt: base + personalities + datetime + relevant memories + reasoning instructions
  6. Push current user message (+ optional imageBase64Url) onto sliding window
  7. Agentic loop up to maxRounds:
       a. Call ILLMOrchestrator
       b. If no tool calls → capture finalReply, break
       c. Execute all tool calls in parallel (single retry on failure)
       d. Persist ASSISTANT_TOOL_CALL + all TOOL results (concurrent)
       e. Push results onto sliding window
  8. Persist assistant reply → IMessageDB
  9. setImmediate (non-blocking post-processing):
       - Write evaluation_logs row (system prompt hash, memories, tool calls, token usage)
       - Detect implicit signal on previous turn's log (correction / repeat / clarification)
       - Extract facts from last 4 messages → embed + upsert to Pinecone + user_memories
       - Update conversations.intent via ITextGenerator
       - Flag conversation for compression if post-turn token estimate > 70k
 10. Return IChatResponse { conversationId, messageId, reply, toolsUsed }
```

---

## Reminder system

Three background workers start automatically (wired in `telegramCli.ts`). They loop over all users from `user_profiles`. Users without a `telegram_chat_id` (i.e. no profile yet) are skipped or marked failed.

### CalendarCrawler
Runs every 30 minutes. Loops all users in parallel. Looks 24 hours ahead per user, creates a `scheduled_notifications` row for each upcoming calendar event at `eventStart - CALENDAR_REMINDER_OFFSET_MINS` (default 30). Deduplicates by `sourceId` (Google event ID).

### DailySummaryCrawler
Runs every 5 minutes. Loops all users in parallel. Fires once per day per user at their configured wake-up hour (set during `/setup`). Fetches that day's calendar events and sends a morning agenda via Telegram to their `telegram_chat_id`. Deduplicates by `daily_summary_<userId>_<date>`.

### NotificationRunner
Polls `scheduled_notifications` every 60 seconds. Fetches due rows, batch-loads the relevant user profiles, then sends each via Telegram to the user's `telegram_chat_id`. Marks rows `sent` on success, `failed` on missing profile or send error.

---

## Not implemented / known limitations

| Item | Note |
| ---- | ---- |
| Image history | Past image messages stored as `[image]` in DB; image data is not persisted |
| **dream** | End-of-day job that sweeps the day's conversation history, extracts and consolidates personal facts, and upserts them into the user memory store — building a richer personal profile over time without requiring the user to explicitly say "remember this" |
| **evaluate** (explicit feedback) | Per-turn `evaluation_logs` rows are written (system prompt hash, memories injected, tool calls, token usage, implicit signal detection). Explicit feedback — user rating or correction via a bot command — is not yet implemented |

---

## Database schema

Defined in `src/adapters/implementations/output/sqlDB/schema.ts`. Run `npm run db:generate && npm run db:migrate` after changes.

| Table                 | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `users`               | User record — personalities used to personalise system prompt       |
| `conversations`       | Per-user conversation threads — adds `summary`, `intent`, `flagged_for_compression` |
| `messages`            | All messages (user/assistant/tool) within a conversation — adds `compressed_at_epoch` |
| `jarvis_config`       | Singleton — stores system prompt and max tool rounds                |
| `user_memories`       | RAG memory store — content, enriched content, category, Pinecone ID |
| `google_oauth_tokens` | Per-user Google OAuth tokens for Calendar + Gmail                   |
| `todo_items`          | To-do list — title, description, deadline (epoch), priority, status |
| `user_profiles`       | Per-user personality traits, wake-up hour, and `telegram_chat_id` (set via `/setup`) |
| `allowed_telegram_ids` | Allowlist — only chat IDs in this table can interact with the bot; admin-managed via `/allow` / `/revoke` |
| `evaluation_logs`     | Per-turn evaluation log — system prompt hash, memories injected, tool calls, token usage, feedback signals |
| `scheduled_notifications` | Reminder queue — title, body, fire-at epoch, status (pending/sent/failed), sourceId for deduplication |

---

## Google OAuth setup

An OAuth callback HTTP server runs on port 3000 (configurable via `OAUTH_CALLBACK_PORT`). The recommended flow is:

1. Run `/setup` in Telegram — after the personality quiz it presents a "Connect Google" button that opens the OAuth consent URL.
2. After authorizing, Google redirects to `GOOGLE_REDIRECT_URI` (your port-3000 server). If the redirect page loads, tokens are stored automatically.
3. If the redirect page doesn't load, copy the `code` query parameter from the redirect URL and send `/code <value>` in Telegram — the bot exchanges it for tokens manually.

Until a token is present, calendar and Gmail tools return `CalendarNotConnectedError` / `GmailNotConnectedError`.

---

## Running the project

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in environment variables (set BOT_ADMIN_TELEGRAM_ID)
cp .env.example .env

# 3. Generate and apply DB migrations
npm run db:generate
npm run db:migrate

# 4. Seed the admin's own chat ID into the allowlist (one-time)
# psql $DATABASE_URL -c "INSERT INTO allowed_telegram_ids (telegram_chat_id, added_at_epoch) VALUES ('<your_chat_id>', EXTRACT(EPOCH FROM NOW())::integer) ON CONFLICT DO NOTHING;"

# 5. Start Telegram bot
npm run dev

# Other utilities
npm run db:studio    # Drizzle Studio GUI
npm run db:push      # Push schema without migration files (dev only)
npm run build        # Compile to dist/
```

---

## Environment variables

See `.env.example` for the full list.

---

## Querying the database

```bash
psql $(grep DATABASE_URL .env | cut -d= -f2-)
# or
npm run db:studio
```

---

## Coding conventions

### IDs and timestamps

Never use `crypto.randomUUID()` or `Date.now()` directly — always use the project helpers:

```typescript
import { newUuid } from "../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
```

All `*_at_epoch` columns store seconds, not milliseconds.

### Comments

Only add a comment when the code cannot explain itself: unit conversion mismatches, non-obvious performance decisions, crash-recovery edge cases. No JSDoc, no section dividers, no explanatory prose.

### DB facade — concrete vs interface

`assistant.di.ts` holds a `DrizzleSqlDB` concrete instance. Repos are properties on the concrete class. When adding a new repo, add it to `DrizzleSqlDB` — no need to touch `ISqlDB`.

---

## Patterns

### Adding a new tool

1. Add a value to `TOOL_TYPE` in `src/helpers/enums/toolType.enum.ts`.
2. Create `src/adapters/implementations/output/tools/myTool.tool.ts` implementing `ITool`.
3. Register it inside the `registryFactory` closure in `AssistantInject.getUseCase()`.

**`ITool` interface:**

```typescript
interface ITool {
  definition(): IToolDefinition;
  execute(input: IToolInput): Promise<IToolOutput>;
}
interface IToolDefinition {
  name: TOOL_TYPE;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}
interface IToolOutput {
  success: boolean;
  data?: unknown;
  error?: string;
}
```

Tools self-validate their own prerequisites. If a required parameter is missing (e.g., an email address for Gmail search), return `{ success: false, error: "..." }` with an actionable message — do not rely on system prompt instructions.

**Registry factory pattern:** `registryFactory(userId)` is called on every request to build a fresh `ToolRegistryConcrete` with `userId` injected — this is how tools receive per-request user identity.

---

### Adding a new DB table

1. `src/adapters/implementations/output/sqlDB/schema.ts` — add `pgTable(...)` definition.
2. `src/use-cases/interface/output/repository/myThing.repo.ts` — domain type + outbound port interface.
3. `src/adapters/implementations/output/sqlDB/repositories/myThing.repo.ts` — Drizzle implementation.
4. `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` — add property + instantiate in constructor.
5. `src/adapters/inject/assistant.di.ts` — pass `sqlDB.myThings` to whatever needs it.

After step 1: `npm run db:generate && npm run db:migrate`.
