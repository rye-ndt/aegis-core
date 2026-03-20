# JARVIS — Personal AI Assistant

A personal AI assistant that listens to your questions (text or voice), reasons over context, and executes tools to get things done. Built with a clean Hexagonal Architecture so every component is swappable without touching business logic.

---

## Table of Contents

1. [What it does](#what-it-does)
2. [Architecture](#architecture)
3. [Project structure](#project-structure)
4. [Core concepts](#core-concepts)
   - [Conversation flow](#conversation-flow)
   - [Tool system](#tool-system)
   - [Voice input](#voice-input)
   - [User authentication](#user-authentication)
5. [Key interfaces (ports)](#key-interfaces-ports)
6. [Concrete adapters](#concrete-adapters)
7. [HTTP API](#http-api)
8. [Database schema](#database-schema)
9. [Enums reference](#enums-reference)
10. [Environment variables](#environment-variables)
11. [Running the project](#running-the-project)
12. [Extending JARVIS](#extending-jarvis)

---

## What it does

JARVIS receives a question from the user — either as text or as a voice clip — and:

1. (If voice) Transcribes the audio to text via **Whisper**.
2. Loads the conversation history from the database.
3. Passes the full context to an **LLM Orchestrator** (OpenAI) along with a list of available **tools**.
4. The orchestrator either replies directly or issues **tool calls** (e.g. web search, send email, read calendar).
5. Tool results are fed back to the orchestrator, which generates a final text reply.
6. Every message — user, assistant, and tool — is persisted so the conversation is resumable.

---

## Architecture

JARVIS follows **Hexagonal Architecture** (Ports & Adapters), also known as the "Clean Architecture" style.

```
┌─────────────────────────────────────────────────────┐
│                   Inbound Adapters                  │
│         HTTP controllers  ·  CLI interface          │
└──────────────────────┬──────────────────────────────┘
                       │  calls
┌──────────────────────▼──────────────────────────────┐
│                    Use Cases                        │
│     AssistantUseCaseImpl  ·  UserUseCaseImpl        │
│   (pure business logic — no framework dependency)   │
└──────────┬──────────────────────┬───────────────────┘
           │ drives               │ drives
┌──────────▼──────────┐  ┌───────▼───────────────────┐
│   Outbound Ports    │  │    Outbound Ports          │
│  (interfaces only)  │  │   (interfaces only)        │
│  ISpeechToText      │  │  IUserDB · IConversationDB │
│  ILLMOrchestrator   │  │  IMessageDB                │
│  IToolRegistry      │  │  ITokenIssuer              │
│  ITool              │  │  IEmailSender · ...        │
└──────────┬──────────┘  └───────┬───────────────────┘
           │ implemented by       │ implemented by
┌──────────▼──────────────────────▼───────────────────┐
│                 Outbound Adapters                   │
│  WhisperSpeechToText  ·  OpenAIOrchestrator         │
│  WebSearchTool  ·  SendEmailTool                    │
│  CalendarTool  ·  ReminderTool                      │
│  DrizzleSqlDB  ·  JwtTokenIssuer  ·  ...            │
└─────────────────────────────────────────────────────┘
```

**Rules:**
- Use cases depend **only on interfaces** (ports), never on concrete adapters.
- Adapters depend on use-case interfaces, never on each other.
- Dependency injection wires everything together in `src/adapters/inject/`.

---

## Project structure

```
src/
├── main.ts                          # HTTP server entry point
├── userCli.ts                       # CLI for user management
│
├── core/
│   └── entities/
│       ├── User.ts                  # User domain entity + validation rules
│       └── Greeting.ts
│
├── use-cases/
│   ├── implementations/
│   │   ├── assistant.usecase.ts     # Core JARVIS logic (chat, voice, tool dispatch)
│   │   └── user.usecase.ts          # Auth: register, login, logout, refresh, verify
│   │
│   └── interface/
│       ├── input/                   # Inbound ports (what callers can do)
│       │   ├── assistant.interface.ts   # IAssistantUseCase
│       │   ├── user.interface.ts        # IUserUseCase
│       │   ├── userHttp.interface.ts    # HTTP request shapes for user endpoints
│       │   └── test.interface.ts        # IGreetingUseCase
│       │
│       ├── output/                  # Outbound ports (what the use cases need)
│       │   ├── speechToText.interface.ts    # ISpeechToText
│       │   ├── llmOrchestrator.interface.ts # ILLMOrchestrator
│       │   ├── tool.interface.ts            # ITool, IToolRegistry, IToolDefinition
│       │   ├── emailSender.interface.ts     # IEmailSender
│       │   ├── passwordHasher.interface.ts  # IPasswordHasher
│       │   ├── tokenIssuer.interface.ts     # ITokenIssuer
│       │   ├── verificationCodeStore.interface.ts
│       │   ├── sqlDB.interface.ts           # ISqlDB, ITransaction
│       │   ├── IGreetingRepo.ts
│       │   └── repository/
│       │       ├── conversation.repo.ts     # IConversationDB, Conversation
│       │       ├── message.repo.ts          # IMessageDB, Message
│       │       └── user.repo.ts             # IUserDB, IUser, UserInit, UserUpdate
│       │
│       └── shared/
│           ├── error.ts             # IError, throwError
│           └── pagination.ts        # IPaginated<T>
│
├── adapters/
│   ├── inject/                      # Dependency injection containers
│   │   ├── index.ts                 # DepInject — main wiring entry point
│   │   ├── assistant.di.ts          # Wires AssistantUseCaseImpl + controller
│   │   ├── user.di.ts               # Wires UserUseCaseImpl + controller
│   │   └── greeting.di.ts
│   │
│   └── implementations/
│       ├── input/http/              # Inbound HTTP adapters
│       │   ├── httpServer.ts        # Raw Node.js HTTP server + route registry
│       │   ├── assistant.controller.ts  # POST /api/assistant/chat, voice, conversations
│       │   ├── user.controller.ts       # POST /api/users/*
│       │   ├── greeting.controller.ts
│       │   └── helper.ts            # readJsonBody<T>
│       │
│       └── output/                  # Outbound adapters
│           ├── speechToText/
│           │   └── whisper.speechToText.ts   # [SKELETON] OpenAI Whisper
│           ├── llmOrchestrator/
│           │   └── openai.llmOrchestrator.ts # [SKELETON] OpenAI chat + tool_use
│           ├── tools/
│           │   ├── webSearch.tool.ts   # [SKELETON] Web search API
│           │   ├── sendEmail.tool.ts   # Delegates to IEmailSender (working shell)
│           │   ├── calendar.tool.ts    # [SKELETON] Calendar API
│           │   └── reminder.tool.ts    # [SKELETON] Reminder scheduling
│           ├── toolRegistry.concrete.ts     # In-memory tool registry
│           ├── emailSender/
│           │   └── unosend.emailSender.ts
│           ├── passwordHasher/
│           │   └── bcrypt.passwordHasher.ts
│           ├── tokenIssuer/
│           │   └── jwt.tokenIssuer.ts        # JWT + Redis revocation list
│           ├── verificationCodeStore/
│           │   └── redis.verificationCodeStore.ts
│           ├── sqlDB/
│           │   ├── schema.ts                 # Drizzle table definitions
│           │   ├── drizzlePostgres.db.ts     # pg Pool setup
│           │   ├── drizzleSqlDb.adapter.ts   # ISqlDB facade
│           │   └── repositories/
│           │       └── user.repo.ts          # DrizzleUserRepo
│           └── greetingRepo.ts
│
└── helpers/
    ├── enums/
    │   ├── toolType.enum.ts         # TOOL_TYPE (web_search, send_email, ...)
    │   ├── messageRole.enum.ts      # MESSAGE_ROLE (user, assistant, system, tool)
    │   ├── statuses.enum.ts         # USER_STATUSES, CONVERSATION_STATUSES
    │   ├── errorCodes.enum.ts       # USER_ERROR_CODES, ASSISTANT_ERROR_CODES
    │   ├── personalities.enum.ts    # PERSONALITIES (calm, analytical, ...)
    │   ├── userRole.enum.ts         # USER_ROLES
    │   ├── tokenIssuer.enum.ts
    │   ├── emailValidation.enum.ts
    │   ├── passwordValidation.enum.ts
    │   ├── passwordHasher.enum.ts
    │   ├── verificationCode.enum.ts
    │   ├── verificationEmail.enum.ts
    │   ├── unosend.enum.ts
    │   ├── userCliCommands.enum.ts
    │   └── format.enum.ts           # DISPLAY_FORMAT (text, image, audio, ...)
    ├── time/
    │   └── dateTime.ts              # newCurrentUTCEpoch()
    ├── uuid.ts                      # newUuid() — UUID v4
    └── verificationCode.ts          # generateVerificationCode()
```

---

## Core concepts

### Conversation flow

```
User sends text / voice
        │
        ▼
AssistantUseCaseImpl.chat()
        │
        ├─ Create conversation (if new) → IConversationDB.create()
        ├─ Persist user message         → IMessageDB.create()
        ├─ Load history                 → IMessageDB.findByConversationId()
        │
        ▼
ILLMOrchestrator.chat(systemPrompt, history, tools)
        │
        ├─ Returns text reply  ──────────────────────────────────┐
        │                                                         │
        └─ Returns tool calls                                     │
                │                                                 │
                ▼                                                 │
        IToolRegistry.getByName(toolName)                         │
        ITool.execute(input)                                      │
        Persist tool result → IMessageDB.create()                 │
        (loop for each tool call)                                 │
                │                                                 │
                └──── re-run orchestrator with tool results ──────┘
                                │
                                ▼
                Persist assistant reply → IMessageDB.create()
                Return IChatResponse { conversationId, reply, toolsUsed }
```

### Tool system

Every tool implements `ITool`:

```typescript
interface ITool {
  definition(): IToolDefinition;          // name, description, JSON Schema input
  execute(input: IToolInput): Promise<IToolOutput>;
}
```

Tools are registered in `ToolRegistryConcrete` and looked up by `TOOL_TYPE` enum at runtime. To add a new tool:
1. Add a value to `src/helpers/enums/toolType.enum.ts`.
2. Create a class implementing `ITool` in `src/adapters/implementations/output/tools/`.
3. Register it in `src/adapters/inject/assistant.di.ts`.

Current tools (all skeletons unless noted):

| Tool | Type | Status |
|------|------|--------|
| `WebSearchTool` | `WEB_SEARCH` | Skeleton — needs search API key |
| `SendEmailTool` | `SEND_EMAIL` | Working shell — delegates to `IEmailSender` |
| `CalendarTool` | `CALENDAR_READ` | Skeleton — needs calendar API |
| `ReminderTool` | `REMINDER_SET` | Skeleton — needs scheduler |

### Voice input

`AssistantUseCaseImpl.voiceChat()` receives a raw audio `Buffer` + MIME type, calls `ISpeechToText.transcribe()`, and forwards the resulting text to `chat()`.

The only concrete implementation is `WhisperSpeechToText` (skeleton). To wire it, implement the `transcribe()` method using the OpenAI Whisper API or a local Whisper model.

### User authentication

Full auth flow is implemented and working:

| Endpoint | Description |
|----------|-------------|
| `POST /api/users/register` | Create account, send email verification code |
| `POST /api/users/verify-email` | Confirm 6-digit code from email |
| `POST /api/users/login` | Returns bearer + refresh JWT tokens |
| `POST /api/users/logout` | Revokes bearer token in Redis |
| `POST /api/users/refresh` | Issues new token pair from refresh token |

Tokens are JWTs signed with `JWT_SECRET`. The revocation list lives in Redis.

---

## Key interfaces (ports)

### `IAssistantUseCase` — `src/use-cases/interface/input/assistant.interface.ts`

```typescript
interface IAssistantUseCase {
  chat(input: IChatInput): Promise<IChatResponse>;
  voiceChat(input: IVoiceChatInput): Promise<IChatResponse>;
  listConversations(input: IListConversationsInput): Promise<Conversation[]>;
  getConversation(input: IGetConversationInput): Promise<Message[]>;
}
```

### `ILLMOrchestrator` — `src/use-cases/interface/output/llmOrchestrator.interface.ts`

```typescript
interface ILLMOrchestrator {
  chat(input: IOrchestratorInput): Promise<IOrchestratorResponse>;
}
// IOrchestratorResponse = { text?: string; toolCalls?: IToolCall[] }
```

### `ITool` — `src/use-cases/interface/output/tool.interface.ts`

```typescript
interface ITool {
  definition(): IToolDefinition;   // name + JSON Schema
  execute(input: IToolInput): Promise<IToolOutput>;
}
```

### `ISpeechToText` — `src/use-cases/interface/output/speechToText.interface.ts`

```typescript
interface ISpeechToText {
  transcribe(input: ISpeechToTextInput): Promise<ISpeechToTextResult>;
}
```

### `IConversationDB` / `IMessageDB` — `src/use-cases/interface/output/repository/`

```typescript
interface IConversationDB {
  create(c: Conversation): Promise<void>;
  update(c: Conversation): Promise<void>;
  findById(id: string): Promise<Conversation | null>;
  findByUserId(userId: string): Promise<Conversation[]>;
  delete(id: string): Promise<void>;
}

interface IMessageDB {
  create(m: Message): Promise<void>;
  findByConversationId(id: string): Promise<Message[]>;
  deleteByConversationId(id: string): Promise<void>;
}
```

---

## Concrete adapters

| Interface | Concrete class | File |
|-----------|---------------|------|
| `ISpeechToText` | `WhisperSpeechToText` | `output/speechToText/whisper.speechToText.ts` |
| `ILLMOrchestrator` | `OpenAIOrchestrator` | `output/llmOrchestrator/openai.llmOrchestrator.ts` |
| `IToolRegistry` | `ToolRegistryConcrete` | `output/toolRegistry.concrete.ts` |
| `IEmailSender` | `UnosendEmailSender` | `output/emailSender/unosend.emailSender.ts` |
| `IPasswordHasher` | `BcryptPasswordHasher` | `output/passwordHasher/bcrypt.passwordHasher.ts` |
| `ITokenIssuer` | `JwtTokenIssuer` | `output/tokenIssuer/jwt.tokenIssuer.ts` |
| `IVerificationCodeStore` | `RedisVerificationCodeStore` | `output/verificationCodeStore/redis.verificationCodeStore.ts` |
| `ISqlDB` | `DrizzleSqlDB` | `output/sqlDB/drizzleSqlDb.adapter.ts` |
| `IUserDB` | `DrizzleUserRepo` | `output/sqlDB/repositories/user.repo.ts` |

> `IConversationDB` and `IMessageDB` concrete implementations are **not yet created**. Wire them in `assistant.di.ts` once built.

---

## HTTP API

### Assistant endpoints

| Method | Path | Body / Params | Description |
|--------|------|---------------|-------------|
| `POST` | `/api/assistant/chat` | `{ userId, conversationId?, message }` | Send a text message |
| `POST` | `/api/assistant/voice` | multipart audio | Send a voice clip (not yet implemented) |
| `GET` | `/api/assistant/conversations` | `{ userId }` in body | List all conversations |
| `GET` | `/api/assistant/conversations/:id` | `{ userId }` in body | Get messages in a conversation |

### User endpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/users/register` | `{ fullName, userName, password, dob, email }` | Register |
| `POST` | `/api/users/login` | `{ userName, password }` | Login |
| `POST` | `/api/users/logout` | — (Bearer token in header) | Logout |
| `POST` | `/api/users/refresh` | — (Refresh token in header) | Refresh tokens |
| `POST` | `/api/users/verify-email` | `{ code }` (Bearer token in header) | Verify email |

### Greeting endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/greeting` | Generic greeting |
| `GET` | `/api/greeting/:name` | Personalized greeting |

---

## Database schema

Defined in `src/adapters/implementations/output/sqlDB/schema.ts` using Drizzle ORM.

### `users`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `full_name` | text | |
| `user_name` | text | |
| `hashed_password` | text | bcrypt |
| `email` | text | |
| `dob` | integer | Unix epoch |
| `role` | text | `USER_ROLES` enum |
| `status` | text | `USER_STATUSES` enum |
| `personalities` | text[] | `PERSONALITIES` enum values |
| `secondary_personalities` | text[] | |
| `created_at_epoch` | integer | |
| `updated_at_epoch` | integer | |

### `conversations`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid | FK to users |
| `title` | text | First 60 chars of opening message |
| `status` | text | `CONVERSATION_STATUSES` enum |
| `created_at_epoch` | integer | |
| `updated_at_epoch` | integer | |

### `messages`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `conversation_id` | uuid | FK to conversations |
| `role` | text | `MESSAGE_ROLE` enum |
| `content` | text | Message text or serialized tool result |
| `tool_name` | text? | Set when role = `tool` |
| `tool_call_id` | text? | Links tool result to its call |
| `created_at_epoch` | integer | |

---

## Enums reference

| File | Enum | Values |
|------|------|--------|
| `toolType.enum.ts` | `TOOL_TYPE` | `web_search`, `send_email`, `calendar_read`, `calendar_write`, `reminder_set`, `reminder_list`, `weather`, `code_execution`, `file_read`, `file_write`, `http_request` |
| `messageRole.enum.ts` | `MESSAGE_ROLE` | `user`, `assistant`, `system`, `tool` |
| `statuses.enum.ts` | `CONVERSATION_STATUSES` | `active`, `archived` |
| `statuses.enum.ts` | `USER_STATUSES` | `need_verification`, `waiting_for_verification`, `active`, `blocked`, `deleted` |
| `personalities.enum.ts` | `PERSONALITIES` | `calm`, `analytical`, `creative`, `logical`, `direct`, `formal`, `casual`, ... |
| `errorCodes.enum.ts` | `USER_ERROR_CODES` | `USER_ALREADY_EXISTS`, `WEAK_PASSWORD`, `INVALID_EMAIL`, `INVALID_TOKEN`, `USER_NOT_FOUND`, `USER_ALREADY_VERIFIED`, `INVALID_VERIFICATION_CODE` |
| `errorCodes.enum.ts` | `ASSISTANT_ERROR_CODES` | `CONVERSATION_NOT_FOUND`, `TOOL_NOT_FOUND`, `TRANSCRIPTION_FAILED`, `ORCHESTRATION_FAILED`, `UNKNOWN_ERROR` |
| `format.enum.ts` | `DISPLAY_FORMAT` | `text`, `image`, `video`, `audio`, `pdf`, `document`, `excel`, `powerpoint`, `json`, `csv`, `tsv` |

---

## Environment variables

```env
PORT=3000

# PostgreSQL
DATABASE_URL=postgresql://user:password@host:5432/jarvis

# Redis (token revocation + verification codes)
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=your-secret-key

# OpenAI (orchestrator + Whisper transcription)
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o

# Email (Unosend)
UNOSEND_API_KEY=un_...
UNOSEND_FROM_EMAIL=jarvis@yourdomain.com

# Web search tool (when implemented)
WEB_SEARCH_API_KEY=...
```

---

## Running the project

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env   # then fill in values

# Run DB migrations
npm run db:generate
npm run db:migrate

# Start (development)
npm run dev

# Start (production)
npm run build && npm start

# User management CLI
ts-node src/userCli.ts
```

---

## Extending JARVIS

### Add a new tool

1. Add a value to `TOOL_TYPE` in `src/helpers/enums/toolType.enum.ts`.
2. Create `src/adapters/implementations/output/tools/myTool.tool.ts` implementing `ITool`.
3. Register it in `AssistantInject.getUseCase()` inside `src/adapters/inject/assistant.di.ts`.

### Swap the LLM

Implement `ILLMOrchestrator` with a different provider (Anthropic, Ollama, Mistral, etc.) and update `AssistantInject` to instantiate it.

### Swap the speech-to-text engine

Implement `ISpeechToText` (e.g. local Whisper, AssemblyAI, Deepgram) and update `AssistantInject`.

### Add conversation/message DB repositories

1. Create `DrizzleConversationRepo` and `DrizzleMessageRepo` in `src/adapters/implementations/output/sqlDB/repositories/`.
2. Expose them from `DrizzleSqlDB`.
3. Wire them in `AssistantInject.getUseCase()`.
