# JARVIS — Development Status

> Last updated: 2026-03-25. Synthesised from `readme.md`, `context.md`, and session memory.

---

## What it is

A personal AI assistant (text + voice) built in TypeScript with **Hexagonal Architecture**. The user sends a message; JARVIS reasons over conversation history, calls tools as needed, and returns a reply. Every component is behind an interface so adapters are swappable without touching business logic.

Converted from an earlier study-companion project (Memora) to a JARVIS-style assistant.

---

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript 5.3, Node.js, strict mode |
| HTTP server | Raw `node:http` (no Express/Fastify) |
| ORM | Drizzle ORM + PostgreSQL (`pg` driver) |
| Auth | JWT (`jsonwebtoken`) + Redis (`ioredis`) for token revocation |
| Password | `bcrypt` |
| LLM | OpenAI (chat completions + tool use) |
| Speech-to-text | OpenAI Whisper (stub — not implemented) |
| Email | Unosend (transactional) |
| Validation | Zod 4.3.6 |
| DI | Manual container in `src/adapters/inject/` |
| Vector DB | Pinecone (`@pinecone-database/pinecone`) |
| Messaging | Telegram (`node-telegram-bot-api` or similar) |

---

## Architecture

Hexagonal (Ports & Adapters). Use cases depend only on interfaces; adapters never depend on each other; DI wiring lives entirely in `src/adapters/inject/`.

---

## Project structure

```
src/
├── main.ts                     # HTTP server entry point (npm run dev)
├── consoleCli.ts               # Interactive chat REPL (npm run chat)
├── jarvisCli.ts                # Config CLI — view/set system prompt (npm run jarvis)
├── telegramCli.ts              # Telegram bot entry point (npm run telegram)
│
├── core/entities/
│   ├── User.ts
│   └── Greeting.ts
│
├── use-cases/
│   ├── implementations/
│   │   ├── assistant.usecase.ts    # chat(), voiceChat(), listConversations(), getConversation()
│   │   └── user.usecase.ts         # register, login, logout, refresh, verify-email
│   └── interface/
│       ├── input/                  # Inbound ports: IAssistantUseCase, IUserUseCase
│       └── output/                 # Outbound ports: ISpeechToText, ILLMOrchestrator,
│                                   # ILLMProvider, ITool, IToolRegistry, IConversationDB,
│                                   # IMessageDB, IUserDB, IJarvisConfigDB, IUserMemoryDB,
│                                   # IEmailSender, ITokenIssuer, IPasswordHasher, ...
│
├── adapters/
│   ├── inject/
│   │   ├── index.ts               # Main DI entry point
│   │   ├── assistant.di.ts        # Wires assistant use case + controller
│   │   └── user.di.ts             # Wires user use case + controller
│   │
│   └── implementations/
│       ├── input/
│       │   ├── http/              # assistant.controller, user.controller, httpServer
│       │   └── telegram/          # TelegramBot, TelegramAssistantHandler
│       │
│       └── output/
│           ├── speechToText/      # WhisperSpeechToText [STUB]
│           ├── llmOrchestrator/   # OpenAIOrchestrator [STUB]
│           ├── llmProvider/       # OpenAILLMProvider [working]
│           ├── calendarService/   # GoogleCalendarService [working]
│           ├── embeddingService/  # OpenAIEmbeddingService [working]
│           ├── vectorStore/       # PineconeVectorStore [working]
│           ├── textGenerator/     # OpenAITextGenerator [working]
│           ├── tools/
│           │   ├── sendEmail.tool.ts          # [working]
│           │   ├── calendarRead.tool.ts       # [working]
│           │   ├── calendarWrite.tool.ts      # [working]
│           │   ├── storeUserMemory.tool.ts    # [working]
│           │   └── retrieveUserMemory.tool.ts # [working]
│           ├── toolRegistry.concrete.ts       # [working]
│           ├── jarvisConfig/      # CachedJarvisConfigRepo (Redis + DB) [working]
│           ├── emailSender/       # UnosendEmailSender [working]
│           ├── passwordHasher/    # BcryptPasswordHasher [working]
│           ├── tokenIssuer/       # JwtTokenIssuer + Redis revocation [working]
│           ├── verificationCodeStore/ # RedisVerificationCodeStore [working]
│           └── sqlDB/             # DrizzleSqlDB + all repos [working]
│
└── helpers/
    ├── enums/
    │   ├── toolType.enum.ts       # SEND_EMAIL, CALENDAR_READ, CALENDAR_WRITE,
    │   │                          # STORE_USER_MEMORY, RETRIEVE_USER_MEMORY
    │   ├── messageRole.enum.ts
    │   ├── statuses.enum.ts
    │   ├── personalities.enum.ts
    │   └── ...
    ├── time/dateTime.ts
    ├── uuid.ts
    └── verificationCode.ts
```

---

## Two LLM abstraction layers

| Interface | Adapter | Used by | Status |
|---|---|---|---|
| `ILLMOrchestrator` | `OpenAIOrchestrator` | `AssistantUseCaseImpl` (HTTP path) | **Stub** — throws not-implemented |
| `ILLMProvider` | `OpenAILLMProvider` | `consoleCli.ts`, `telegramCli.ts` | **Working** |

`ILLMProvider` maintains per-conversation history in-memory (`Map<conversationId, messages[]>`). `textReply()` reports context window usage %. `toolCall()` forces `tool_choice: "required"` and validates args against Zod schema.

---

## Conversation flow (HTTP API path)

```
User → POST /api/assistant/chat
         │
         ▼
AssistantUseCaseImpl.chat()
  1. Load or create conversation → IConversationDB
  2. Persist user message → IMessageDB
  3. Load config from CachedJarvisConfigRepo (Redis → DB) for system prompt
  4. Call ILLMOrchestrator with history + tool definitions   ← STUB, not working yet
  5. If tool calls: ITool.execute() via IToolRegistry; persist TOOL messages
  6. Persist assistant reply → IMessageDB
  7. Return IChatResponse { conversationId, messageId, reply, toolsUsed }
```

> The HTTP assistant path is blocked on `OpenAIOrchestrator.chat()` being a stub. The CLI paths (`consoleCli.ts`, `telegramCli.ts`) use `OpenAILLMProvider` and work end-to-end.

## Conversation flow (CLI / Telegram path)

**Important:** `consoleCli.ts` calls `OpenAILLMProvider.textReply()` **directly** — it does **not** go through `AssistantUseCaseImpl`. There is no tool dispatch, no DB persistence, and no system-prompt loading from the use case layer. It loads the system prompt itself from `CachedJarvisConfigRepo` and passes it straight to the provider.

`telegramCli.ts` wires through `AssistantInject().getUseCase()` and calls `AssistantUseCaseImpl.chat()`, so it does go through the use case — but since `OpenAIOrchestrator` is a stub, tools are never actually called from Telegram either in the current state.

```
consoleCli.ts (REPL)
  └─ CachedJarvisConfigRepo.get()       # loads system prompt
  └─ OpenAILLMProvider.textReply()      # direct call, no use case, no tools, no DB

telegramCli.ts
  └─ AssistantUseCaseImpl.chat()        # goes through use case
       └─ OpenAIOrchestrator.chat()     # ← STUB, throws — tools never called
```

---

## Stubs (not yet implemented)

| Adapter | Blocks |
|---|---|
| `OpenAIOrchestrator` (`output/llmOrchestrator/`) | HTTP API assistant path — `chat()` throws |
| `WhisperSpeechToText` (`output/speechToText/`) | `POST /api/assistant/voice` |

Everything else in `src/adapters/implementations/output/` is working. See project structure for the full list.

---

## Database schema

Defined in `src/adapters/implementations/output/sqlDB/schema.ts`. Run `npm run db:generate && npm run db:migrate` after changes.

| Table | Purpose |
|---|---|
| `users` | User accounts, roles, status, personalities |
| `conversations` | Per-user conversation threads |
| `messages` | All messages (user/assistant/tool) within a conversation |
| `jarvis_config` | Singleton row — stores the JARVIS system prompt |
| `user_memories` | RAG memory store — content, enriched content, category, Pinecone ID |
| `google_oauth_tokens` | Per-user Google OAuth tokens for Calendar access |

---

## HTTP API

### Assistant
| Method | Path | Description |
|---|---|---|
| POST | `/api/assistant/chat` | Send text message (blocked on orchestrator stub) |
| POST | `/api/assistant/voice` | Voice input — returns 501 |
| GET | `/api/assistant/conversations` | List user conversations |
| GET | `/api/assistant/conversations/:id` | Get messages in conversation |

### Users
| Method | Path | Description |
|---|---|---|
| POST | `/api/users/register` | Create account, send email verification |
| POST | `/api/users/verify-email` | Confirm 6-digit code |
| POST | `/api/users/login` | Returns bearer + refresh JWT tokens |
| POST | `/api/users/logout` | Revokes bearer token |
| POST | `/api/users/refresh` | Issues new token pair |

---

## Environment variables

```env
PORT=3000
DATABASE_URL=postgresql://user:password@host:5432/jarvis
REDIS_URL=redis://localhost:6379
JWT_SECRET=...
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
UNOSEND_API_KEY=un_...
UNOSEND_FROM_EMAIL=jarvis@yourdomain.com
PINECONE_API_KEY=...
PINECONE_INDEX_NAME=memora-user-memories
PINECONE_HOST=...               # optional
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=...
TELEGRAM_BOT_TOKEN=...
JARVIS_USER_ID=...              # fixed userId for CLI / Telegram sessions
```

---

## What still needs to be done

1. **`OpenAIOrchestrator.chat()`** — implement with OpenAI chat completions + `tool_choice: "auto"`. This unblocks the HTTP API assistant path entirely.
2. **`WhisperSpeechToText.transcribe()`** — implement using OpenAI Whisper API; unblocks `POST /api/assistant/voice`.
3. **Google OAuth flow** — the Calendar tools and `GoogleCalendarService` exist, but there is no HTTP endpoint to initiate the OAuth handshake and store tokens for a user.

---

## Querying the database

When you need to inspect live data (rows, schema state, seeded values), connect directly using the `DATABASE_URL` in `.env`:

```bash
psql $(grep DATABASE_URL .env | cut -d= -f2-)
```

Or use Drizzle Studio:

```bash
npm run db:studio
```

---

## Coding conventions

### IDs and timestamps
Never use `crypto.randomUUID()` or `Date.now()` directly. Always use the project helpers:
```typescript
import { newUuid } from "../../helpers/uuid";               // UUID v4
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime"; // Unix epoch in seconds
```
All `*_at_epoch` columns in the DB store seconds, not milliseconds.

### Throwing errors
Use `throwError` with a typed error code — never `throw new Error(...)` in use case code:
```typescript
import { throwError } from "../interface/shared/error";
import { ERROR_CODES } from "../../helpers/enums/errorCodes.enum";

throwError(ERROR_CODES.USER_NOT_FOUND);
```
To add a new error: add a value to the relevant enum in `src/helpers/enums/errorCodes.enum.ts` and add its message to `ERROR_CODES_MAP` in the same file.

### DB facade — concrete vs interface
The DI containers (`assistant.di.ts`, `user.di.ts`) hold a `DrizzleSqlDB` **concrete** instance, not an `ISqlDB`. Repos are properties on the concrete class only. When adding a new repo, add it to `DrizzleSqlDB` — you do **not** need to touch the `ISqlDB` interface.

### consoleCli.ts bypass
`consoleCli.ts` calls `OpenAILLMProvider.textReply()` directly and bypasses `AssistantUseCaseImpl` entirely. New methods added to the use case are **not** automatically available in the REPL — `consoleCli.ts` must be updated separately if REPL support is needed.

---

## Patterns

### Adding a new tool
1. Add a value to `TOOL_TYPE` in `src/helpers/enums/toolType.enum.ts`.
2. Create `src/adapters/implementations/output/tools/myTool.tool.ts` implementing `ITool`.
3. Register it inside the `registryFactory` closure in `AssistantInject.getUseCase()` (`src/adapters/inject/assistant.di.ts`).

**`ITool` interface** (`src/use-cases/interface/output/tool.interface.ts`):
```typescript
interface ITool {
  definition(): IToolDefinition;                    // name, description, JSON Schema
  execute(input: IToolInput): Promise<IToolOutput>; // IToolInput = Record<string, unknown>
}

interface IToolDefinition {
  name: TOOL_TYPE;           // must match a TOOL_TYPE enum value
  description: string;
  inputSchema: Record<string, unknown>; // standard JSON Schema object
}

interface IToolOutput {
  success: boolean;
  data?: unknown;
  error?: string;
}
```

**Registry factory pattern:** tools are not registered once at startup. `AssistantInject` passes a `registryFactory: (userId: string) => IToolRegistry` to `AssistantUseCaseImpl`. On every request the use case calls `registryFactory(userId)` to build a fresh `ToolRegistryConcrete` with `userId` already injected — this is how calendar and memory tools receive per-request user identity.

---

### Adding a new HTTP endpoint

There is no framework — routing is manual. Touch four files:

**1. `src/use-cases/interface/input/assistant.interface.ts`** (or `user.interface.ts`)
Add the input/output types and the method signature to `IAssistantUseCase`.

**2. `src/use-cases/implementations/assistant.usecase.ts`**
Implement the method. Use cases only depend on outbound port interfaces — never on adapters directly.

**3. `src/adapters/implementations/input/http/assistant.controller.ts`**
Add a handler method. Pattern: `readJsonBody<MyInput>(req)` → call use case → `res.writeHead(200)` + `res.end(JSON.stringify(result))`. Wrap in try/catch, return 500 on error. Path params arrive as a plain string argument.

```typescript
async handleMyThing(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  try {
    const body = await readJsonBody<{ userId: string }>(req);
    const result = await this.assistantUseCase.myThing({ userId: body.userId, id });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal Server Error" }));
  }
}
```

**4. `src/adapters/implementations/input/http/httpServer.ts`**
Register the route inside the relevant `register*Controller()` method using `this.addRoute("GET", "/api/path/:param", ...)`. `:param` segments are extracted and passed as the third argument to the handler. Finally, if this is a new controller entirely, wire it in `src/adapters/inject/index.ts` inside `getHttpServer()`.

---

### Adding a new DB table

Touch five files in order:

**1. `src/adapters/implementations/output/sqlDB/schema.ts`**
Add a `pgTable(...)` definition using Drizzle column helpers (`uuid`, `text`, `integer`, etc.). Export it.

**2. `src/use-cases/interface/output/repository/myThing.repo.ts`** *(new file)*
Define the domain type and the outbound port interface:
```typescript
export interface MyThing { id: string; /* ... */ }
export interface IMyThingDB {
  create(t: MyThing): Promise<void>;
  findById(id: string): Promise<MyThing | null>;
}
```

**3. `src/adapters/implementations/output/sqlDB/repositories/myThing.repo.ts`** *(new file)*
Implement `IMyThingDB` against `NodePgDatabase`. Constructor takes `private readonly db: NodePgDatabase`. Use `this.db.insert/select/update/delete` from Drizzle with the schema table imported from `../schema`.

**4. `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts`**
Import the new repo class, add a `readonly myThings: DrizzleMyThingRepo` property, and instantiate it in the constructor: `this.myThings = new DrizzleMyThingRepo(this.db)`.

**5. DI container** (`src/adapters/inject/assistant.di.ts` or `user.di.ts`)
Access via `sqlDB.myThings` and pass to whichever use case or adapter needs it.

After step 1 run `npm run db:generate` then `npm run db:migrate`.

---

### Adding a new use case method (non-tool feature)

Full flow top to bottom:

1. **Port interface** — add method + input/output types to `src/use-cases/interface/input/assistant.interface.ts`
2. **Implementation** — implement in `src/use-cases/implementations/assistant.usecase.ts`; inject any new outbound ports through the constructor
3. **Controller** — add a handler in `src/adapters/implementations/input/http/assistant.controller.ts`
4. **Route** — register in `src/adapters/implementations/input/http/httpServer.ts`
5. **DI wiring** — if a new outbound dependency was introduced, pass it in `src/adapters/inject/assistant.di.ts`

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

# 4. Start options
npm run dev          # HTTP server (development, ts-node)
npm run build        # Compile to dist/
npm start            # Run compiled output

npm run chat         # Interactive REPL (no server needed)
npm run jarvis       # View/set system prompt
npm run telegram     # Telegram bot (needs TELEGRAM_BOT_TOKEN + JARVIS_USER_ID)

# Other DB utilities
npm run db:studio    # Drizzle Studio GUI
npm run db:push      # Push schema without migration files (dev only)
```
