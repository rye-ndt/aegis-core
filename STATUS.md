# JARVIS — Status

> Last updated: 2026-03-27

---

## What it is

A personal, single-user AI assistant built in TypeScript with Hexagonal Architecture. The user sends a message via Telegram; JARVIS reasons over conversation history, calls tools as needed, and returns a reply. Every component is behind an interface so adapters are swappable without touching business logic.

---

## Tech stack

| Layer          | Choice                                         |
| -------------- | ---------------------------------------------- |
| Language       | TypeScript 5.3, Node.js, strict mode           |
| Interface      | Telegram (`grammy`)                            |
| ORM            | Drizzle ORM + PostgreSQL (`pg` driver)         |
| Config cache   | Redis (`ioredis`) — JarvisConfig system prompt |
| LLM            | OpenAI chat completions + tool use (`gpt-4o`)  |
| Speech-to-text | OpenAI Whisper (stub — not implemented)        |
| Vision         | OpenAI gpt-4o vision (base64 data URL)         |
| Validation     | Zod 4.3.6                                      |
| DI             | Manual container in `src/adapters/inject/`     |
| Vector DB      | Pinecone (`@pinecone-database/pinecone`)       |

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
│                                   # IEmbeddingService, IVectorStore, ITextGenerator
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
│           ├── llmOrchestrator/   # OpenAIOrchestrator [working] — vision-capable
│           ├── speechToText/      # WhisperSpeechToText [STUB]
│           ├── calendarService/   # GoogleCalendarService [working]
│           ├── gmailService/      # GoogleGmailService [working]
│           ├── embeddingService/  # OpenAIEmbeddingService [working]
│           ├── vectorStore/       # PineconeVectorStore [working]
│           ├── textGenerator/     # OpenAITextGenerator [working]
│           ├── tools/
│           │   ├── calendarRead.tool.ts       # [working]
│           │   ├── calendarWrite.tool.ts      # [working]
│           │   ├── gmailSearchEmails.tool.ts  # [working]
│           │   ├── gmailCreateDraft.tool.ts   # [working]
│           │   ├── storeUserMemory.tool.ts    # [working]
│           │   ├── retrieveUserMemory.tool.ts # [working]
│           │   ├── createTodoItem.ts          # [working]
│           │   └── retrieveTodoItems.ts       # [working]
│           ├── toolRegistry.concrete.ts       # [working]
│           ├── jarvisConfig/      # CachedJarvisConfigRepo (Redis + DB) [working]
│           └── sqlDB/             # DrizzleSqlDB + all repos [working]
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

```
Telegram message (text or photo)
      │
      ▼
TelegramAssistantHandler.on("message:text" | "message:photo")
  photo path: download highest-res PhotoSize → base64 data URL
      │
      ▼
AssistantUseCaseImpl.chat()
  1. Load or create conversation → IConversationDB
  2. Persist user message (caption or "[image]") → IMessageDB
  3. If image present: inject imageBase64Url into last history entry (in-memory only)
  4. Load config from CachedJarvisConfigRepo (Redis → DB) for system prompt
  5. Build tool registry for this userId (registryFactory)
  6. Loop up to maxRounds:
       a. Call ILLMOrchestrator with history + tool definitions
       b. If no tool calls → persist assistant reply, return
       c. Persist ASSISTANT_TOOL_CALL message
       d. Execute each tool via IToolRegistry → persist TOOL result
  7. Return IChatResponse { conversationId, messageId, reply, toolsUsed }
```

---

## Stubs

| Adapter               | Blocks                                       |
| --------------------- | -------------------------------------------- |
| `WhisperSpeechToText` | `voiceChat()` — not called from Telegram yet |

## Not implemented / known limitations

| Item | Note |
| ---- | ---- |
| Image history | Past image messages stored as `[image]` in DB; image data is not persisted |
| Voice messages | `WhisperSpeechToText` stub — `voiceChat()` not wired to Telegram yet |

---

## Database schema

Defined in `src/adapters/implementations/output/sqlDB/schema.ts`. Run `npm run db:generate && npm run db:migrate` after changes.

| Table                 | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `users`               | User record — personalities used to personalise system prompt       |
| `conversations`       | Per-user conversation threads                                       |
| `messages`            | All messages (user/assistant/tool) within a conversation            |
| `jarvis_config`       | Singleton — stores system prompt and max tool rounds                |
| `user_memories`       | RAG memory store — content, enriched content, category, Pinecone ID |
| `google_oauth_tokens` | Per-user Google OAuth tokens for Calendar + Gmail                   |
| `todo_items`          | To-do list — title, description, deadline (epoch), priority, status |

---

## Google OAuth setup

There is no HTTP server to handle OAuth callbacks. To connect Google Calendar or Gmail, manually insert a token row into `google_oauth_tokens` or run the OAuth flow via a temporary script using the Google OAuth2 client and the `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` env vars. Until a token is present, the calendar and Gmail tools return a `CalendarNotConnectedError` / `GmailNotConnectedError`.

---

## Running the project

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in environment variables
cp .env.example .env

# 3. Generate and apply DB migrations
npm run db:generate
npm run db:migrate

# 4. Start Telegram bot
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
