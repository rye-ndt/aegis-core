# Onchain Agent — Status

> Last updated: 2026-04-09

---

## Vision

A non-custodial, intent-based AI trading agent on Avalanche. Users state natural language intents (e.g., "Buy $100 of AVAX"), the AI parses the intent, and the bot executes the on-chain swap via an ERC-4337 Smart Account using Session Key delegation.

The user never holds a private key. The bot's Master Session Key signs `UserOperation`s on their behalf, authorized by their smart account. Every execution automatically routes a 1% protocol fee to the treasury.

---

## What it is (current implementation)

A stateless AI agent on Telegram backed by Hexagonal Architecture. Users authenticate via JWT (register/login via HTTP API, then `/auth <token>` in Telegram). The agent can answer questions and execute web searches. It remembers conversation history within a session but has no long-term memory per user.

**Web3 status:** Smart contracts remain deployed on Avalanche Fuji testnet. TypeScript integration is pending (Phase 3).

---

## Tech stack

| Layer          | Choice                                                        |
| -------------- | ------------------------------------------------------------- |
| Language       | TypeScript 5.3, Node.js, strict mode                          |
| Interface      | Telegram (`grammy`) + HTTP API (native `http`)                |
| ORM            | Drizzle ORM + PostgreSQL (`pg` driver)                        |
| LLM            | OpenAI chat completions + tool use (`gpt-4o`)                 |
| Validation     | Zod 4.3.6                                                     |
| DI             | Manual container in `src/adapters/inject/`                    |
| Web search     | Tavily (`@tavily/core`)                                       |
| **Blockchain** | Avalanche Fuji Testnet, ERC-4337, Session Keys                |

---

## Architecture

Hexagonal (Ports & Adapters). Use cases depend only on interfaces; adapters never depend on each other; DI wiring lives entirely in `src/adapters/inject/`.

---

## Project structure

```text
src/
├── telegramCli.ts              # Entry point — boots HTTP API + Telegram bot
│
├── use-cases/
│   ├── implementations/
│   │   ├── assistant.usecase.ts    # chat(), listConversations(), getConversation()
│   │   └── auth.usecase.ts         # register(), login(), validateToken()
│   └── interface/
│       ├── input/                  # IAssistantUseCase, IAuthUseCase
│       └── output/                 # Outbound ports
│
├── adapters/
│   ├── inject/
│   │   └── assistant.di.ts        # Wires all components; lazy singletons
│   │
│   └── implementations/
│       ├── input/
│       │   ├── http/              # HttpApiServer — /auth/register, /auth/login
│       │   └── telegram/          # TelegramBot, TelegramAssistantHandler
│       │
│       └── output/
│           ├── orchestrator/      # OpenAIOrchestrator — tool calling + vision
│           ├── webSearch/         # TavilyWebSearchService
│           ├── tools/
│           │   └── webSearch.tool.ts   # Tavily web search, up to 5 results
│           ├── toolRegistry.concrete.ts
│           └── sqlDB/             # DrizzleSqlDB + 4 repositories
│
└── helpers/
    ├── enums/                     # TOOL_TYPE, MESSAGE_ROLE, USER_STATUSES,
    │                              # CONVERSATION_STATUSES
    ├── time/dateTime.ts           # newCurrentUTCEpoch() — seconds, not ms
    └── uuid.ts                    # newUuid() — v4
```

---

## Contract Registry (Avalanche Fuji Testnet)

- **AegisToken (Proxy):** `0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69`
- **RewardController (Proxy):** `0x519092C2185E4209B43d3ea40cC34D39978073A7`
- **SessionKeyFactory:** `0x160E43075D9912FFd7006f7Ad14f4781C7f0D443`
- **SessionKeyManager:** `0xA5264f7599B031fDD523Ab66f6B6FA86ce56d291`
- **ERC-4337 EntryPoint:** `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`

---

## HTTP API

Runs on `HTTP_API_PORT` (default 4000). Native Node.js HTTP — no Express.

| Method | Route            | Auth | Purpose                                            |
| ------ | ---------------- | ---- | -------------------------------------------------- |
| `POST` | `/auth/register` | None | Create account; returns `{ userId }`               |
| `POST` | `/auth/login`    | None | Returns `{ token, expiresAtEpoch, userId }`        |

---

## Telegram commands

| Command         | Behavior                                                                 |
| --------------- | ------------------------------------------------------------------------ |
| `/start`        | Welcome message; prompts authentication if not logged in                 |
| `/auth <token>` | Links JWT to this Telegram chat; persists to `telegram_sessions`         |
| `/logout`       | Deletes session from DB + cache                                          |
| `/new`          | Clears active conversation ID (starts fresh thread)                      |
| `/history`      | Shows last 10 messages of the current conversation                       |
| _(text)_        | Chat with the agent; supports tool calls (web search)                    |
| _(photo)_       | Base64 → vision chat with caption as message                             |

---

## Message flow

```text
Telegram message (text / photo)
      │
      ▼
TelegramAssistantHandler
  → ensureAuthenticated(chatId) — in-memory cache → telegram_sessions DB → JWT expiry
      │
      ▼
AssistantUseCaseImpl.chat()
  1. Create conversation if new
  2. Load prior message history (last 20 uncompressed)
  3. Persist user message
  4. Build sliding window + system prompt
  5. Agentic tool loop (up to MAX_TOOL_ROUNDS, default 10):
       a. Call OpenAIOrchestrator
       b. No tool calls → finalReply, break
       c. Execute tool calls in parallel (single retry on transient failure)
       d. Persist ASSISTANT_TOOL_CALL + TOOL results
  6. Persist assistant reply
  7. Return { conversationId, messageId, reply, toolsUsed }
```

---

## Database schema

| Table               | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `users`             | Account record — hashed password, email, status                     |
| `telegram_sessions` | Links Telegram chat ID → userId with JWT expiry                      |
| `conversations`     | Per-user threads — title, status                                     |
| `messages`          | All turns (user / assistant / tool)                                  |
| `user_profiles`     | Reserved for ERC-4337 wallet abstraction (smartAccountAddress, eoa) |

---

## Pivot roadmap

### Phase 1 — Purge ✅
Removed: RLHF data logging, AGS reward logic, evaluation logs, user memory (vector DB + Pinecone), Google Calendar/Gmail tools, reminder crawlers, TTS/STT, personality customization, todo system, jarvisConfig.

### Phase 2 — Core infrastructure (pending)
- [ ] Swap OpenAI orchestrator for `AnthropicOrchestrator` (Claude Sonnet 4.6)
- [ ] Wire `SessionKeySmartAccountFactory` in `auth.usecase.ts` on `/register`

### Phase 3 — Execution engine (pending)
- [ ] Intent parser: LLM → strict JSON (`action`, `tokenIn`, `tokenOut`, `amount`, `slippage`)
- [ ] Deterministic safety layer: DEX quote, balance check, transaction simulation
- [ ] Protocol fee: 1% auto-routed to treasury on every execution
- [ ] UserOperation builder + ERC-4337 EntryPoint submission via Session Key

---

## Environment variables

| Variable             | Default  | Purpose                                   |
| -------------------- | -------- | ----------------------------------------- |
| `DATABASE_URL`       | —        | PostgreSQL connection string              |
| `OPENAI_API_KEY`     | —        | OpenAI API key                            |
| `OPENAI_MODEL`       | `gpt-4o` | LLM model                                 |
| `TELEGRAM_BOT_TOKEN` | —        | Telegram bot token                        |
| `JWT_SECRET`         | —        | JWT signing secret                        |
| `JWT_EXPIRES_IN`     | `7d`     | Token lifetime                            |
| `HTTP_API_PORT`      | `4000`   | HTTP API port                             |
| `TAVILY_API_KEY`     | —        | Tavily web search key                     |
| `MAX_TOOL_ROUNDS`    | `10`     | Max agentic tool rounds per chat          |
| `AVAX_RPC_URL`       | —        | Avalanche RPC endpoint                    |
| `BOT_PRIVATE_KEY`    | —        | Session key wallet private key            |
| `ENTRY_POINT_ADDRESS`| —        | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` |
| `JARVIS_ACCOUNT_FACTORY_ADDRESS` | — | `0x160E43075D9912FFd7006f7Ad14f4781C7f0D443` |
| `SESSION_KEY_MANAGER_ADDRESS`    | — | `0xA5264f7599B031fDD523Ab66f6B6FA86ce56d291` |

---

## Coding conventions

### IDs and timestamps

```typescript
import { newUuid } from "../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
```

All `*_at_epoch` columns store **seconds**, not milliseconds.

### Comments

Only add a comment when the code cannot explain itself: unit conversion mismatches, non-obvious performance decisions, crash-recovery edge cases. No JSDoc, no section dividers.

### DB facade

`assistant.di.ts` holds a `DrizzleSqlDB` concrete instance. Repos are properties on the concrete class.

---

## Patterns

### Adding a new tool

1. Add a value to `TOOL_TYPE` in `src/helpers/enums/toolType.enum.ts`.
2. Create `src/adapters/implementations/output/tools/myTool.tool.ts` implementing `ITool`.
3. Register it inside the `registryFactory` closure in `AssistantInject.getUseCase()`.

### Adding a new DB table

1. `schema.ts` — add `pgTable(...)`.
2. `src/use-cases/interface/output/repository/myThing.repo.ts` — domain type + interface.
3. `src/adapters/implementations/output/sqlDB/repositories/myThing.repo.ts` — Drizzle impl.
4. `drizzleSqlDb.adapter.ts` — add property + instantiate.
5. `assistant.di.ts` — pass `sqlDB.myThings` to whatever needs it.
6. `npm run db:generate && npm run db:migrate`
