# Onchain Agent — Status

## Things I should add in

- proactive agent: ask the agent to gather market sentiment daily, analyze it and give out the verdict for today' investment status
- temporarily disable the RAG. we need speed and correctness. enable it once we have multiple tools

## What it is

A non-custodial, intent-based AI trading agent on Avalanche, backed by Hexagonal Architecture (Ports & Adapters). Users authenticate via Privy (Google OAuth), link their session with `/auth <token>` in Telegram. The agent parses natural language intents, simulates them via ERC-4337 UserOperations, and submits them on-chain via Session Keys. Users can send tokens to any Telegram handle — the bot resolves the handle to an EVM wallet via MTProto + Privy. The frontend connects via SSE to receive signing requests pushed from the bot. Use cases depend only on interfaces; adapters never depend on each other; DI wiring lives entirely in `src/adapters/inject/`.

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
│   │   ├── auth.usecase.ts         # loginWithPrivy() — verifies Privy token, returns JWT
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
| `POST`   | `/auth/privy`              | None               | Verify Privy token → `{ token, expiresAtEpoch, userId }` |
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
| `/auth <privy_token>`                  | Verifies Privy token, links userId to Telegram chat                                |
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
