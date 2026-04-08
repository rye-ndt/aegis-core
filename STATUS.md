# JARVIS — Status

> Last updated: 2026-04-06

---

## What it is

A multi-user AI assistant built in TypeScript with Hexagonal Architecture. Users interact via Telegram; JARVIS reasons over conversation history, calls tools as needed, and returns a reply. Authentication is JWT-based — users register/login via HTTP API, then link their Telegram session with `/auth <token>`. Every component is behind an interface so adapters are swappable without touching business logic.

---

## Tech stack

| Layer          | Choice                                         |
| -------------- | ---------------------------------------------- |
| Language       | TypeScript 5.3, Node.js, strict mode           |
| Interface      | Telegram (`grammy`) + HTTP API (native `http`) |
| ORM            | Drizzle ORM + PostgreSQL (`pg` driver)         |
| Config cache   | Redis (`ioredis`) — JarvisConfig system prompt |
| LLM            | OpenAI chat completions + tool use (`gpt-4o`) — usage tokens surfaced |
| Text-to-speech | OpenAI TTS `tts-1`, opus/ogg format            |
| Speech-to-text | OpenAI Whisper `whisper-1`                     |
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
│                               # Boots HTTP API, Telegram bot, NotificationRunner,
│                               # CalendarCrawler, DailySummaryCrawler; SIGINT shutdown
│
├── use-cases/
│   ├── implementations/
│   │   ├── assistant.usecase.ts    # chat(), voiceChat(), listConversations(), getConversation()
│   │   └── auth.usecase.ts         # register(), login(), validateToken()
│   └── interface/
│       ├── input/                  # IAssistantUseCase, IAuthUseCase
│       └── output/                 # All outbound ports (see list below)
│
├── adapters/
│   ├── inject/
│   │   └── assistant.di.ts        # Wires all 20+ components; lazy singletons
│   │
│   └── implementations/
│       ├── input/
│       │   ├── http/              # HttpApiServer — 4 routes
│       │   └── telegram/          # TelegramBot (INotificationSender), TelegramAssistantHandler
│       │
│       └── output/
│           ├── orchestrator/      # OpenAIOrchestrator — tool calling + vision
│           ├── stt/               # WhisperSpeechToText — whisper-1, ogg input
│           ├── textToSpeech/      # OpenAITTS — tts-1, opus/ogg
│           ├── textGenerator/     # OpenAITextGenerator — summarisation, enrichment
│           ├── embedding/         # OpenAIEmbeddingService — text-embedding-3-small
│           ├── vectorDB/          # PineconeVectorStore
│           ├── calendar/          # GoogleCalendarService — CRUD + OAuth token refresh
│           ├── mail/              # GoogleGmailService — search + draft creation
│           ├── googleOAuth/       # GoogleOAuthService — auth URL + code exchange
│           ├── webSearch/         # TavilyWebSearchService
│           ├── tools/
│           │   ├── calendarRead.tool.ts       # List events by date range + search
│           │   ├── calendarWrite.tool.ts      # Create / update / delete calendar events
│           │   ├── gmailSearchEmails.tool.ts  # Gmail search, returns metadata
│           │   ├── gmailCreateDraft.tool.ts   # Create draft (not auto-sent), threading support
│           │   ├── storeUserMemory.tool.ts    # Enrich → embed → upsert Pinecone + DB
│           │   ├── retrieveUserMemory.tool.ts # Semantic search, score ≥ 0.75, updates lastAccessed
│           │   ├── createTodoItem.ts          # Create todo + auto-schedule reminder notification
│           │   ├── retrieveTodoItems.ts       # List todos by status/priority
│           │   └── webSearch.tool.ts          # Tavily web search, up to 5 results
│           ├── toolRegistry.concrete.ts       # Map-based registry
│           ├── jarvisConfig/      # CachedJarvisConfigRepo — Redis + DB
│           ├── reminder/
│           │   ├── calendarCrawler.ts         # Polls calendar per user, schedules notifications
│           │   ├── dailySummaryCrawler.ts      # Morning agenda at wake-up hour
│           │   └── notificationRunner.ts      # Dispatches due notifications via Telegram
│           └── sqlDB/             # DrizzleSqlDB + 11 repositories
│
└── helpers/
    ├── enums/                     # TOOL_TYPE, PERSONALITIES, MESSAGE_ROLE, USER_STATUSES,
    │                              # CONVERSATION_STATUSES, JARVIS_CONFIG
    ├── errors/
    │   ├── calendarNotConnected.error.ts
    │   └── gmailNotConnected.error.ts
    ├── time/dateTime.ts           # newCurrentUTCEpoch() — seconds, not ms
    └── uuid.ts                    # newUuid() — v4
```

---

## HTTP API

Runs on `HTTP_API_PORT` (default 4000). Native Node.js HTTP — no Express.

| Method | Route | Auth | Purpose |
| ------ | ----- | ---- | ------- |
| `POST` | `/auth/register` | None | Create account; returns `{ userId }` |
| `POST` | `/auth/login` | None | Returns `{ token, expiresAtEpoch, userId }` |
| `GET`  | `/auth/google` | Bearer JWT | Returns Google OAuth consent URL |
| `GET`  | `/api/auth/google/calendar/callback` | `?code=&state=` | OAuth callback — stores tokens |

---

## Telegram commands

| Command | Behavior |
| ------- | -------- |
| `/start` | Welcome; redirects to `/auth` if not logged in |
| `/auth <token>` | Links JWT to this Telegram chat; persists to `telegram_sessions` |
| `/logout` | Deletes session from DB + cache; invalidates Telegram access immediately |
| `/new` | Clears active conversation ID (starts fresh thread) |
| `/history` | Shows last 10 messages of the current conversation |
| `/setup` | 6-question personality quiz (a/b), then wake-up hour, then Google OAuth link |
| `/code <auth_code>` | Manual fallback — exchanges Google OAuth code for tokens |
| `/speech <message>` | Chat → TTS → returns OGG voice reply; text fallback if TTS fails |
| _(voice message)_ | Whisper transcription → chat → TTS reply; text fallback |
| _(photo message)_ | Base64 → vision chat |

---

## Normal message flow

```
Telegram message (text / photo / voice)
      │
      ▼
TelegramAssistantHandler
  → ensureAuthenticated(chatId) — in-memory cache → telegram_sessions DB → JWT expiry
  → ensureUserProfile(userId, chatId)
      │
      ▼
AssistantUseCaseImpl.chat()
  1. Create conversation if new
  2. Parallel batch:
       - prior message history
       - semantic memory search (embed → Pinecone, score ≥ 0.75)
       - jarvis_config (Redis → DB)
       - user_profiles (personalities)
       - persist user message
  3. Compression check: if uncompressed tokens > 80k or flagged
       - LLM-summarise oldest messages
       - upsertSummary + markCompressed
  4. Build sliding window: [summary?] + recent messages
  5. Build system prompt: base + personalities + datetime + memories + reasoning instructions
  6. Agentic tool loop (up to maxToolRounds, default 10):
       a. Call OpenAIOrchestrator
       b. No tool calls → finalReply, break
       c. Execute all tool calls in parallel (single retry on transient failure)
       d. Persist ASSISTANT_TOOL_CALL + TOOL results
       e. Push results onto sliding window
  7. Persist assistant reply
  8. setImmediate post-processing (non-blocking):
       - Write evaluation_logs (prompt hash, memories, tool calls, token usage)
       - LLM-based implicit feedback detection on turn N−FEEDBACK_WINDOW_SIZE (correction / repeat / clarification / positive + outcomeConfirmed)
       - Extract facts from last 4 messages → embed → upsert Pinecone + user_memories
       - Update conversations.intent
       - Flag for compression if tokens > 70k
  9. Return { conversationId, messageId, reply, toolsUsed }
```

---

## Reminder system

Three background workers start automatically in `telegramCli.ts`. All intervals and offsets are configurable via env vars.

### CalendarCrawler
Runs every `CALENDAR_CRAWL_INTERVAL_MINS` (default 30). Scans `CALENDAR_LOOK_AHEAD_HOURS` (default 24) ahead per user. Schedules a notification at `eventStart − CALENDAR_REMINDER_OFFSET_MINS` (default 30). Deduplicates by Google event ID.

### DailySummaryCrawler
Runs every 5 minutes. Fires once per day per user at their wake-up hour (configured in `/setup`). Fetches that day's calendar events and sends a morning agenda to their Telegram chat. Deduplicates by `daily_summary_<userId>_<date>`.

### NotificationRunner
Polls `scheduled_notifications` every `NOTIFICATION_POLL_INTERVAL_SECS` (default 60). Fetches due rows, resolves Telegram chat IDs from `user_profiles`, sends via Telegram. Marks rows `sent` or `failed`.

---

## Database schema

Defined in `src/adapters/implementations/output/sqlDB/schema.ts`. Run `npm run db:generate && npm run db:migrate` after changes.

| Table | Purpose |
| ----- | ------- |
| `users` | Account record — hashed password, email, status |
| `telegram_sessions` | Links Telegram chat ID → userId with JWT expiry |
| `conversations` | Per-user threads — summary, intent, flagged_for_compression |
| `messages` | All turns (user / assistant / tool) — compressed_at_epoch |
| `jarvis_config` | Singleton — system prompt, max tool rounds |
| `user_memories` | RAG store — content, enriched content, category, Pinecone ID |
| `google_oauth_tokens` | Per-user OAuth tokens for Calendar + Gmail |
| `todo_items` | Todos — title, description, deadline (epoch), priority, status |
| `user_profiles` | Per-user personality traits, wake-up hour, telegram_chat_id |
| `evaluation_logs` | Per-turn log — prompt hash, memories injected, tool calls, token usage, feedback signals |
| `scheduled_notifications` | Reminder queue — fire_at_epoch, status (pending/sent/failed), sourceId for deduplication |

---

## Not implemented / known limitations

| Item | Note |
| ---- | ---- |
| Image history | Past image messages stored as `[image]` in DB; image data is not persisted |
| Explicit feedback | `evaluation_logs` rows are written; implicit signal detection uses LLM analysis over a configurable window (`FEEDBACK_WINDOW_SIZE`, default 3). Explicit user rating via a bot command is not implemented |
| **dream** | End-of-day job to sweep conversation history, consolidate facts, and upsert them into the memory store — building a richer profile without requiring explicit "remember this" commands |
| Rate limiting | No rate limiting on HTTP API or tool calls |
| Structured logging | Uses `console.error/log` only; no log levels or rotation |
| Tests | No test files |

---

## Running the project

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in environment variables
cp .env.example .env

# 3. Apply DB migrations
npm run db:migrate

# 4. Start
npm run dev

# Utilities
npm run db:generate  # Generate migration from schema changes
npm run db:migrate   # Apply pending migrations
npm run db:studio    # Drizzle Studio GUI
npm run build        # Compile to dist/
```

---

## Environment variables

See `.env.example` for the full list. Key variables:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_URL` | — | Redis connection string |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_MODEL` | `gpt-4o` | LLM model |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token |
| `JWT_SECRET` | — | JWT signing secret (`openssl rand -hex 32`) |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `HTTP_API_PORT` | `4000` | HTTP API port |
| `CALENDAR_REMINDER_OFFSET_MINS` | `30` | Minutes before event to fire reminder |
| `CALENDAR_LOOK_AHEAD_HOURS` | `24` | Hours ahead crawler scans for events |
| `CALENDAR_CRAWL_INTERVAL_MINS` | `30` | How often calendar crawler runs |
| `NOTIFICATION_POLL_INTERVAL_SECS` | `60` | How often notification runner dispatches |
| `TODO_REMINDER_OFFSET_HOURS` | `24` | Hours before todo deadline to fire reminder |
| `PINECONE_API_KEY` | — | Pinecone API key |
| `PINECONE_INDEX_NAME` | — | Pinecone index name (1536 dims, cosine) |
| `GOOGLE_CLIENT_ID` | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | — | Must match Google Cloud Console |
| `TAVILY_API_KEY` | — | Tavily web search key |
| `MAX_TOOL_ROUNDS` | `10` | Max agentic tool rounds per chat |
| `FEEDBACK_WINDOW_SIZE` | `3` | Messages after a turn before evaluating implicit feedback |

---

## Coding conventions

### IDs and timestamps

Never use `crypto.randomUUID()` or `Date.now()` directly:

```typescript
import { newUuid } from "../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
```

All `*_at_epoch` columns store **seconds**, not milliseconds.

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

Tools self-validate their own prerequisites. If a required parameter is missing, return `{ success: false, error: "..." }` with an actionable message — do not rely on system prompt instructions.

**Registry factory pattern:** `registryFactory(userId)` is called on every request to build a fresh `ToolRegistryConcrete` with `userId` injected.

---

### Adding a new DB table

1. `src/adapters/implementations/output/sqlDB/schema.ts` — add `pgTable(...)`.
2. `src/use-cases/interface/output/repository/myThing.repo.ts` — domain type + interface.
3. `src/adapters/implementations/output/sqlDB/repositories/myThing.repo.ts` — Drizzle implementation.
4. `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` — add property + instantiate.
5. `src/adapters/inject/assistant.di.ts` — pass `sqlDB.myThings` to whatever needs it.
6. `npm run db:generate && npm run db:migrate`

---

## Google OAuth flow

1. `/setup` in Telegram → personality quiz → presents "Connect Google" InlineKeyboard button.
2. User taps → Google consent → redirects to `GOOGLE_REDIRECT_URI` (HTTP API callback). Tokens stored automatically.
3. If redirect doesn't load, copy `code` from URL and send `/code <value>` in Telegram.

Until tokens are present, calendar and Gmail tools return `CalendarNotConnectedError` / `GmailNotConnectedError` and the bot reports the service is not connected.
