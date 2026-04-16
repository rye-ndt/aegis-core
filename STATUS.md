# Onchain Agent — Status

## Things I should add in

- proactive agent: ask the agent to gather market sentiment daily, analyze it and give out the verdict for today' investment status
- temporarily disable the RAG. we need speed and correctness. enable it once we have multiple tools

## What it is

A non-custodial, intent-based AI trading agent on Avalanche, backed by Hexagonal Architecture (Ports & Adapters). Users authenticate via Privy (Google OAuth or Telegram). When the Mini App logs in, it passes the user's Telegram chatId to `POST /auth/privy`, which automatically links the session — no manual `/auth <token>` step needed. The agent parses natural language intents (including fiat shortcuts like "$5"), simulates them via ERC-4337 UserOperations, and submits them on-chain via Session Keys. Users can send tokens to any Telegram handle — the bot resolves the handle to an EVM wallet via MTProto + Privy. The frontend connects via SSE to receive signing requests pushed from the bot. Use cases depend only on interfaces; adapters never depend on each other; DI wiring lives entirely in `src/adapters/inject/`.

## Tech stack

| Layer      | Choice                                                         |
| ---------- | -------------------------------------------------------------- |
| Language   | TypeScript 5.3, Node.js, strict mode                           |
| Interface  | Telegram (`grammy`) + HTTP API (native `http`)                 |
| ORM        | Drizzle ORM + PostgreSQL (`pg` driver)                         |
| LLM        | Anthropic Claude (`claude-sonnet-4-6`) via `@anthropic-ai/sdk` |
| Blockchain | `viem` ^2 — public + wallet clients; Avalanche Fuji, ERC-4337  |
| Validation | Zod 4.3.6                                                      |
| DI         | Manual container in `src/adapters/inject/`                     |
| Web search | Tavily (`@tavily/core`)                                        |
| Cache      | Redis via `ioredis` (shared client)                            |

## Project structure

```text
src/
├── telegramCli.ts              # Entry point — boots HTTP API + Telegram bot
│
├── use-cases/
│   ├── implementations/
│   │   ├── assistant.usecase.ts    # chat(), listConversations(), getConversation()
│   │   ├── auth.usecase.ts         # loginWithPrivy() — verifies Privy token, returns JWT; optionally upserts telegram_sessions if telegramChatId provided
│   │   ├── intent.usecase.ts       # parseAndExecute() → confirmAndExecute()
│   │   ├── signingRequest.usecase.ts # createRequest() → SSE push → resolveRequest() → notify
│   │   ├── tokenIngestion.usecase.ts # ingest() — fetch → map → upsert token registry
│   │   └── toolRegistration.usecase.ts # register() + list() — Zod validation, collision check
│   └── interface/
│       ├── input/                  # IAssistantUseCase, IAuthUseCase, IIntentUseCase,
│       │                           # ISigningRequestUseCase, ITokenIngestionUseCase,
│       │                           # IToolRegistrationUseCase
│       └── output/                 # Outbound ports
│           ├── blockchain/         # ISmartAccountService, ISessionKeyService,
│           │                       # IUserOperationBuilder, IPaymasterService
│           ├── solver/             # ISolver, ISolverRegistry (async getSolverAsync)
│           ├── cache/              # ISigningRequestCache, ISessionDelegationCache
│           ├── sse/                # ISseRegistry (push, connect)
│           ├── repository/         # 9 repo interfaces (users → feeRecords)
│           ├── intentParser.interface.ts   # IntentPackage (action: string, params?), SimulationReport
│           ├── toolManifest.types.ts       # ToolManifest Zod schemas + deserializeManifest
│           ├── toolIndex.interface.ts      # IToolIndexService (index, search, delete)
│           ├── telegramResolver.interface.ts # ITelegramHandleResolver + TelegramHandleNotFoundError
│           ├── simulator.interface.ts
│           ├── tokenCrawler.interface.ts   # ITokenCrawlerJob, CrawledToken
│           └── tokenRegistry.interface.ts
│
├── adapters/
│   ├── inject/
│   │   └── assistant.di.ts        # Wires all components; lazy singletons
│   │
│   └── implementations/
│       ├── input/
│       │   ├── http/              # HttpApiServer — all HTTP routes
│       │   ├── jobs/              # TokenCrawlerJob — driving adapter, fires on timer
│       │   └── telegram/          # TelegramBot, TelegramAssistantHandler
│       │
│       └── output/
│           ├── orchestrator/      # AnthropicOrchestrator (active), OpenAIOrchestrator (unused)
│           ├── blockchain/        # viemClient, smartAccount, sessionKey,
│           │                      # userOperation.builder, paymaster
│           ├── solver/
│           │   ├── solverRegistry.ts             # async DB fallback via ManifestDrivenSolver
│           │   ├── static/claimRewards.solver.ts
│           │   ├── restful/traderJoe.solver.ts
│           │   └── manifestSolver/               # dynamic tool execution engine
│           │       ├── templateEngine.ts         # {{x.y.z}} resolver
│           │       ├── stepExecutors.ts          # http_get, http_post, abi_encode, erc20_transfer…
│           │       └── manifestDriven.solver.ts  # ISolver driven by ToolManifest steps
│           ├── simulator/         # rpc.simulator.ts — viem eth_call simulation
│           ├── intentParser/      # anthropic.intentParser.ts — LLM → IntentPackage
│           ├── tokenRegistry/     # db.tokenRegistry.ts
│           ├── tokenCrawler/      # pangolin.tokenCrawler.ts (ITokenCrawlerJob)
│           ├── resultParser/      # tx.resultParser.ts — receipt → human string
│           ├── webSearch/         # TavilyWebSearchService
│           ├── tools/             # webSearch.tool.ts, executeIntent.tool.ts, getPortfolio.tool.ts
│           ├── toolIndex/         # PineconeToolIndexService (IToolIndexService)
│           ├── sse/               # SseRegistry — in-memory userId→res map + heartbeat
│           ├── cache/             # redis.sessionDelegation.ts, redis.signingRequest.ts
│           ├── telegram/          # GramjsTelegramResolver — MTProto contacts.ResolveUsername
│           ├── toolRegistry.concrete.ts
│           └── sqlDB/             # DrizzleSqlDB + 10 repositories
│
└── helpers/
    ├── enums/                     # TOOL_TYPE, MESSAGE_ROLE, USER_STATUSES,
    │                              # CONVERSATION_STATUSES, INTENT_STATUSES,
    │                              # EXECUTION_STATUSES, SESSION_KEY_STATUSES,
    │                              # SOLVER_TYPE, TOOL_CATEGORY
    ├── errors/toErrorMessage.ts   # toErrorMessage(unknown) → string helper
    ├── time/dateTime.ts           # newCurrentUTCEpoch() — seconds, not ms
    └── uuid.ts                    # newUuid() — v4
```

## Contract Registry (Avalanche Fuji Testnet)

- **AegisToken (Proxy):** `0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69`
- **RewardController (Proxy):** `0x519092C2185E4209B43d3ea40cC34D39978073A7`

## HTTP API

Runs on `HTTP_API_PORT` (default 4000). Native Node.js HTTP — no Express.

| Method   | Route                      | Auth               | Purpose                                                  |
| -------- | -------------------------- | ------------------ | -------------------------------------------------------- |
| `POST`   | `/auth/privy`              | None               | Verify Privy token → `{ token, expiresAtEpoch, userId }`; optional `telegramChatId` body field links the Telegram session atomically |
| `GET`    | `/intent/:intentId`        | JWT                | Fetch intent + execution status                          |
| `GET`    | `/portfolio`               | JWT                | On-chain balances for user's SCA                         |
| `GET`    | `/tokens?chainId=`         | None               | List verified tokens for a chain                         |
| `POST`   | `/tools`                   | JWT                | Register a dynamic tool manifest                         |
| `GET`    | `/tools`                   | None               | List active tool manifests                               |
| `DELETE` | `/tools/:toolId`           | JWT                | Deactivate a tool manifest                               |
| `POST`   | `/persistent`              | None               | Persist a session delegation record (from frontend)      |
| `GET`    | `/permissions?public_key=` | None               | Fetch delegation record by session key address           |
| `GET`    | `/delegation/pending`      | JWT                | Fetch latest pending delegation for the user             |
| `POST`   | `/delegation/:id/signed`   | JWT                | Mark a pending delegation as signed                      |
| `GET`    | `/events`                  | JWT (or `?token=`) | SSE stream — receives `sign_request` events              |
| `POST`   | `/sign-response`           | JWT                | Submit txHash (or rejection) for a signing request       |

---

## Telegram commands

| Command                                | Behavior                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `/start`                               | Welcome message; prompts authentication if not logged in                           |
| `/auth <privy_token>`                  | Verifies Privy token, links userId to Telegram chat (fallback; Mini App users are linked automatically via `POST /auth/privy`) |
| `/logout`                              | Deletes session from DB + cache                                                    |
| `/new`                                 | Clears active conversation ID (starts fresh thread)                                |
| `/history`                             | Shows last 10 messages of the current conversation                                 |
| `/confirm`                             | Executes the latest `AWAITING_CONFIRMATION` intent                                 |
| `/cancel`                              | Aborts the pending intent (no tx submitted)                                        |
| `/portfolio`                           | Shows on-chain token balances for user's SCA                                       |
| `/wallet`                              | Shows SCA address + session key status                                             |
| `/sign <to> <value_wei> <data> <desc>` | Creates a signing request; pushes via SSE to the connected frontend                |
| _(text)_                               | Chat with the agent; supports tool calls (web search, executeIntent, getPortfolio) |
| _(photo)_                              | Base64 → vision chat with caption as message                                       |

## Intent execution flow

```text
User message: "Swap 100 USDC for AVAX"
      │
      ▼
TelegramAssistantHandler
  → classifyIntent() → selectTool() → compileSchema() [multi-turn until complete]
  → resolveTokens() [disambiguation prompt if >1 match]
  → resolveRecipientHandle() [if @handle present: MTProto → Privy wallet]
  → buildRequestBody() → show confirmation + delegation request
      │
User sends /confirm
      │
      ▼
IntentUseCaseImpl.confirmAndExecute()
  1. Rebuild calldata via solver
  2. UserOpBuilder.submit()       → { userOpHash }
  3. UserOpBuilder.waitForReceipt() → { txHash, success }
  4. Save intent_executions + fee_records
  5. TxResultParser.parse()       → human success string
  6. notifyRecipient() if P2P transfer
```

## `bot.on("message:text")` — how it works

Every plain text message the user types goes through a single handler. Here's what happens, step by step.

### 0. Auth gate
The first thing the handler does is call `ensureAuthenticated`. It checks an in-memory cache; if the session isn't cached it hits the DB. If no valid session is found, it replies "please authenticate" and stops.

### 1. Typing indicator
`ctx.replyWithChatAction("typing")` is sent so the user sees the "..." bubble while the bot works.

### 2. Check for an in-progress session (`OrchestratorSession`)
The handler looks up `orchestratorSessions` (an in-memory map keyed by `chatId`).

- **If the session is in `token_disambig` stage** — the user is being asked to pick between multiple tokens with the same symbol. The message is treated as a selection (number or exact symbol string). Once the user picks, the flow resumes from where disambiguation interrupted it. → `handleDisambiguationReply()`

- **If there is no active session** — this is a fresh request. The handler checks whether the text starts with a recognized intent command (e.g. `/buy`, `/swap`, `/send`).
  - **Command found** → `startCommandSession()` — deterministic pipeline (see phases below).
  - **No command** → `startLegacySession()` — the LLM first classifies the intent type, then selects a tool, then compiles.

- **If the session is in `compile` stage** — the bot previously asked a follow-up question and is waiting for the user's answer. The new message is appended to the conversation and the compile loop continues. → `continueCompileLoop()`

### Phase 1 — Tool selection
The handler calls `intentUseCase.selectTool()` to find the right registered tool for this intent (e.g. the "swap" tool manifest). If no tool is found, it falls back to a plain LLM chat reply.

### Phase 2 — Schema compilation (LLM extraction loop)
`intentUseCase.compileSchema()` sends the conversation so far to the LLM, which extracts all required parameters from the tool's input schema (amount, token symbols, recipient, etc.). If anything is still missing, the LLM generates a follow-up question that is sent back to the user. The session is saved and the handler exits — it will resume on the next message. This loop runs up to `MAX_TOOL_ROUNDS` (default 10) before giving up.

During compilation:
- If a `@telegramHandle` was mentioned as the recipient, `resolveRecipientHandle()` looks it up via MTProto and maps it to an EVM address.
- Extracted values are accumulated in `session.partialParams` and `session.resolverFields`.

### Phase 2→3 transition — validation
After the LLM says it has everything, `getMissingRequiredFields()` does a deterministic check against the manifest schema. If anything is still missing, another question is generated (bypassing the LLM extraction cost).

### Phase 3 — Token / recipient resolution
Two paths, depending on whether the tool manifest declares `requiredFields` (dual-schema):

- **Dual-schema path** — `runResolutionPhase()` calls `resolverEngine.resolve()` which converts human-readable values (e.g. `"USDC"`, `"0.5"`) into exact on-chain data (contract address, raw wei amount, recipient wallet). If a token symbol matches multiple contracts, a `DisambiguationRequiredError` is thrown — the handler catches it, saves the candidates, switches the session to `token_disambig`, and asks the user to pick one.
- **Legacy path** — `resolveTokensAndFinish()` does a simple `searchTokens()` lookup by symbol (same disambiguation flow applies).

### Phase 4 — Confirmation prompt
`buildAndShowConfirmationFromResolved()` (dual-schema) or `buildAndShowConfirmation()` (legacy) assembles the calldata via `intentUseCase.buildRequestBody()`, then sends the user a human-readable transaction preview with the exact parameters and calldata. The session is cleared from memory. The user must send `/confirm` to execute or `/cancel` to abort.

### Summary diagram

```
message:text
  │
  ├─ token_disambig? ──→ handleDisambiguationReply → (resume phase 3 or 4)
  │
  ├─ no session + command → startCommandSession
  │                              └─→ compileSchema (Phase 2)
  ├─ no session + free text → startLegacySession
  │                              └─→ classifyIntent → selectTool → compileSchema (Phase 2)
  │
  └─ compile stage → continueCompileLoop (Phase 2 resumed)
                          │
                          ▼
                    finishCompileOrResolve (Phase 2→3)
                          │
                    ┌─────┴──────┐
              dual-schema    legacy
                    │              │
             runResolutionPhase   resolveTokensAndFinish (Phase 3)
                    │              │
                    └──────┬───────┘
                           ▼
                  buildAndShowConfirmation (Phase 4)
                  → user sees tx preview → /confirm or /cancel
```

## Database schema

| Table               | Purpose                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| `users`             | Account record — hashed password, email, status                                    |
| `telegram_sessions` | Links Telegram chat ID → userId with JWT expiry                                    |
| `conversations`     | Per-user threads — title, status                                                   |
| `messages`          | All turns (user / assistant / tool / assistant_tool_call)                          |
| `user_profiles`     | SCA address, session key address + scope + status                                  |
| `token_registry`    | Symbol → address + decimals per chainId; `deployer_address` nullable               |
| `intents`           | Parsed intent records with status lifecycle                                        |
| `intent_executions` | Per-attempt execution records with userOpHash + txHash                             |
| `tool_manifests`    | Dynamic tool registry — toolId slug, category, steps (JSON), inputSchema, chainIds |
| `fee_records`       | Audit trail of every 1% protocol fee collected                                     |

## Environment variables

| Variable                         | Default                                      | Purpose                                           |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| `DATABASE_URL`                   | `postgres://localhost/aether_intent`         | PostgreSQL connection string                      |
| `ANTHROPIC_API_KEY`              | —                                            | Anthropic API key                                 |
| `ANTHROPIC_MODEL`                | `claude-sonnet-4-6`                          | LLM model                                         |
| `TELEGRAM_BOT_TOKEN`             | —                                            | Telegram bot token                                |
| `JWT_SECRET`                     | —                                            | JWT signing secret                                |
| `JWT_EXPIRES_IN`                 | `7d`                                         | Token lifetime                                    |
| `HTTP_API_PORT`                  | `4000`                                       | HTTP API port                                     |
| `TAVILY_API_KEY`                 | —                                            | Tavily web search key                             |
| `MAX_TOOL_ROUNDS`                | `10`                                         | Max agentic tool rounds per chat                  |
| `AVAX_RPC_URL`                   | Fuji public RPC                              | Avalanche RPC endpoint                            |
| `AVAX_BUNDLER_URL`               | —                                            | ERC-4337 bundler (e.g. Pimlico)                   |
| `BOT_PRIVATE_KEY`                | —                                            | Session key signer private key                    |
| `BOT_ADDRESS`                    | —                                            | On-chain address of BOT_PRIVATE_KEY               |
| `TREASURY_ADDRESS`               | —                                            | Platform fee recipient wallet                     |
| `CHAIN_ID`                       | `43113`                                      | 43113 = Fuji, 43114 = Mainnet                     |
| `ENTRY_POINT_ADDRESS`            | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | ERC-4337 EntryPoint                               |
| `JARVIS_ACCOUNT_FACTORY_ADDRESS` | `0x160E43075D9912FFd7006f7Ad14f4781C7f0D443` | SCA factory                                       |
| `SESSION_KEY_MANAGER_ADDRESS`    | `0xA5264f7599B031fDD523Ab66f6B6FA86ce56d291` | Session key manager                               |
| `REWARD_CONTROLLER_ADDRESS`      | —                                            | Rewards contract for ClaimRewardsSolver           |
| `TRADERJOE_API_URL`              | `https://api.traderjoexyz.com`               | TraderJoe quote API                               |
| `PANGOLIN_TOKEN_LIST_URL`        | Pangolin GitHub raw URL                      | Override Pangolin token list source               |
| `TOKEN_CRAWLER_INTERVAL_MS`      | `900000` (15 min)                            | Token list re-fetch interval                      |
| `REDIS_URL`                      | —                                            | ioredis connection string (shared client)         |
| `TG_API_ID`                      | —                                            | Telegram MTProto API ID (my.telegram.org)         |
| `TG_API_HASH`                    | —                                            | Telegram MTProto API hash                         |
| `TG_SESSION`                     | `""`                                         | Persisted gramjs session; logged on first connect |
| `PRIVY_APP_ID`                   | —                                            | Privy app ID for server-side auth                 |
| `PRIVY_APP_SECRET`               | —                                            | Privy app secret                                  |

## Coding conventions

- IDs: `newUuid()` from `helpers/uuid`. Timestamps: `newCurrentUTCEpoch()` from `helpers/time/dateTime` — **seconds**, not ms.
- Comments only where code cannot explain itself (unit mismatches, crash-recovery edges). No JSDoc, no section dividers.
- DB facade: `assistant.di.ts` holds a `DrizzleSqlDB` concrete instance; repos are properties on it.

## Patterns

**New tool:** add to `TOOL_TYPE` enum → implement `ITool` in `output/tools/` → register in `AssistantInject.getUseCase()` registryFactory.

**New DB table:** `schema.ts` → repo interface → Drizzle impl → add to `DrizzleSqlDB` → wire in `assistant.di.ts` → `npm run db:generate && npm run db:migrate`.

**New solver:** implement `ISolver` in `output/solver/static/` or `restful/` → register in `AssistantInject.getSolverRegistry()`.

**New token crawler source:** implement `ITokenCrawlerJob` → swap in `AssistantInject.getTokenCrawlerJob()`.

---

## Recent changes

### 2026-04-16 — Telegram Login Support

**Goal:** Eliminate the manual `/auth <token>` step for Mini App users.

**What changed:**
- `IPrivyLoginInput` (`auth.interface.ts`) gains optional `telegramChatId?: string`.
- `AuthUseCaseImpl` (`auth.usecase.ts`) accepts an optional `ITelegramSessionDB` as a 5th constructor arg. After issuing the JWT, it upserts a `telegram_sessions` row when `telegramChatId` is present. The field is validated as numeric-string at the HTTP layer before reaching the use-case.
- `POST /auth/privy` (`httpServer.ts`) Zod schema extended: `telegramChatId: z.string().regex(/^\d+$/).optional()`. A non-numeric value returns 400 before any business logic runs.
- `AssistantInject.getAuthUseCase()` (`assistant.di.ts`) now passes `db.telegramSessions` as the 5th arg.
- `bot.on("message:web_app_data", ...)` (`handler.ts`) is kept untouched as a backward-compat fallback; a comment marks it as superseded.
- No schema migrations — `telegram_sessions` already had the right shape.
- No new routes, no new interfaces, no new enums.

**Architecture audit:** `AuthUseCaseImpl` imports only from `use-cases/interface/output/repository/` (output port). No adapter imports in use-cases. No adapter-to-adapter dependencies introduced.

### 2026-04-15 — Fiat / Stablecoin Intent Auto-detection

**Goal:** Non-crypto users writing `"send @alice $5"` or `"5 dollars"` should not be asked which token they mean.

**What changed:**
- Module-level `detectStablecoinIntent(text)` pure function added to `handler.ts`. Matches `$N`, `N dollars`, `N bucks`, `N usd`, `N usdc` (case-insensitive, requires a numeric value).
- After every `compileSchema` call (in `startCommandSession`, `startLegacySession`, `continueCompileLoop`) the function is checked. If the user used fiat language and the LLM did not extract a `fromTokenSymbol`, USDC is injected into both `resolverFields[FROM_TOKEN_SYMBOL]` and `tokenSymbols.from`.
- Detection is sticky across multi-turn sessions (checks the full message history in `continueCompileLoop`).
- No new interfaces, no new DB tables, no new enums.
