# Onchain Agent — Status

## Backlog

- Proactive agent: daily market sentiment → investment verdict
- Temporarily disable RAG (speed/correctness); re-enable once tool count grows

## What it is

Non-custodial, intent-based AI trading agent on Avalanche. Hexagonal Architecture (Ports & Adapters) — use-cases depend only on interfaces; assembly lives entirely in `src/adapters/inject/assistant.di.ts`. Users auth via Privy (Google OAuth or Telegram); Mini App passes `telegramChatId` to `POST /auth/privy` for automatic session linking. Agent parses natural language (including `$5` fiat shortcuts), simulates via ERC-4337 UserOps, submits on-chain via Session Keys. Telegram handles resolved to EVM wallets via MTProto + Privy. Frontend receives signing requests over SSE.

## Tech stack

| Layer      | Choice |
| ---------- | ------ |
| Language   | TypeScript 5.3, Node.js, strict mode |
| Interface  | Telegram (`grammy`) + HTTP API (native `http`) |
| ORM        | Drizzle ORM + PostgreSQL (`pg` driver) |
| LLM        | OpenAI (`gpt-4o` / configurable) via `openai` SDK |
| Blockchain | `viem` ^2 — any EVM chain (configured via `CHAIN_ID`), ERC-4337 |
| Validation | Zod 4.3.6 |
| DI         | Manual container in `src/adapters/inject/` |
| Web search | Tavily (`@tavily/core`) |
| Embeddings | OpenAI embeddings + Pinecone vector index |
| Cache      | Redis via `ioredis` |

## Important rules (non-negotiable)

1. **Never violate hexagonal architecture.** Use-case layer imports only from `use-cases/interface/`. Adapter layer imports from `use-cases/interface/` and its own `adapters/implementations/`. No adapter-to-adapter imports. No concrete classes in use-cases. Assembly happens exclusively in `src/adapters/inject/assistant.di.ts`. Violation = vendor lock-in.

2. **No inline string literals for configuration.** Every configurable value (API URLs, keys, model names, feature flags) must be declared as a named constant at the top of the file, or read from `process.env` (documented in `.env`). No magic strings buried inside functions or constructors.

## Project structure

```text
src/
├── telegramCli.ts              # Entry — boots HTTP API + Telegram bot
├── use-cases/
│   ├── implementations/        # assistant, auth, intent, signingRequest,
│   │                           # tokenIngestion, toolRegistration, httpQueryTool
│   └── interface/
│       ├── input/              # IAssistantUseCase, IAuthUseCase, IIntentUseCase,
│       │                       # ISigningRequestUseCase, ITokenIngestionUseCase,
│       │                       # IToolRegistrationUseCase, IHttpQueryToolUseCase
│       └── output/
│           ├── blockchain/     # ISmartAccountService, ISessionKeyService,
│           │                   # IUserOperationBuilder, IPaymasterService
│           ├── solver/         # ISolver, ISolverRegistry
│           ├── cache/          # ISigningRequestCache, ISessionDelegationCache, IUserProfileCache
│           ├── sse/            # ISseRegistry
│           ├── repository/     # 11 repo interfaces (users → httpQueryTools)
│           ├── walletDataProvider.interface.ts  # IWalletDataProvider + DTOs (Privy-agnostic)
│           ├── systemToolProvider.interface.ts  # ISystemToolProvider.getTools(userId, convId)
│           ├── intentParser.interface.ts        # IntentPackage, SimulationReport
│           ├── toolManifest.types.ts            # ToolManifest Zod schemas
│           ├── toolIndex.interface.ts           # IToolIndexService
│           ├── telegramResolver.interface.ts    # ITelegramHandleResolver
│           ├── simulator.interface.ts
│           ├── tokenCrawler.interface.ts
│           └── tokenRegistry.interface.ts
├── adapters/
│   ├── inject/assistant.di.ts  # Wires all components; lazy singletons
│   └── implementations/
│       ├── input/
│       │   ├── http/           # HttpApiServer — all HTTP routes
│       │   ├── jobs/           # TokenCrawlerJob
│       │   └── telegram/       # TelegramBot, TelegramAssistantHandler
│       └── output/
│           ├── orchestrator/   # OpenAIOrchestrator (active), AnthropicOrchestrator (unused)
│           ├── blockchain/     # viemClient, smartAccount, sessionKey, userOp.builder, paymaster
│           ├── solver/
│           │   ├── solverRegistry.ts
│           │   ├── static/claimRewards.solver.ts
│           │   ├── restful/traderJoe.solver.ts
│           │   └── manifestSolver/  # templateEngine, stepExecutors, manifestDriven.solver
│           ├── intentParser/   # openai.intentParser, openai.intentClassifier, openai.schemaCompiler
│           ├── simulator/      # rpc.simulator.ts
│           ├── tokenRegistry/  # db.tokenRegistry.ts
│           ├── tokenCrawler/   # pangolin.tokenCrawler.ts
│           ├── resultParser/   # tx.resultParser.ts
│           ├── webSearch/      # TavilyWebSearchService
│           ├── tools/          # webSearch, executeIntent, getPortfolio, httpQuery (DB-registered)
│           │   └── system/     # transferErc20, walletBalances, transactionStatus, gasSpend, rpcProxy
│           ├── walletData/     # privy.walletDataProvider.ts
│           ├── toolIndex/      # PineconeToolIndexService
│           ├── embedding/      # openai.embedding.ts
│           ├── sse/            # SseRegistry
│           ├── cache/          # redis.sessionDelegation, redis.signingRequest
│           ├── telegram/       # GramjsTelegramResolver (MTProto)
│           ├── toolRegistry.concrete.ts
│           ├── systemToolProvider.concrete.ts   # assembles 5 system tools
│           └── sqlDB/          # DrizzleSqlDB + 12 repositories
└── helpers/
    ├── enums/                  # TOOL_TYPE, MESSAGE_ROLE, USER_STATUSES, CONVERSATION_STATUSES,
    │                           # INTENT_STATUSES, EXECUTION_STATUSES, SESSION_KEY_STATUSES,
    │                           # SOLVER_TYPE, TOOL_CATEGORY
    ├── crypto/aes.ts           # AES-256-GCM encrypt/decrypt (iv:authTag:ciphertext hex)
    ├── errors/toErrorMessage.ts
    ├── time/dateTime.ts        # newCurrentUTCEpoch() — seconds, not ms
    └── uuid.ts                 # newUuid() — v4
```

## Contract Registry (Avalanche Fuji Testnet)

- **AegisToken (Proxy):** `0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69`
- **RewardController (Proxy):** `0x519092C2185E4209B43d3ea40cC34D39978073A7`

## HTTP API

Runs on `HTTP_API_PORT` (default 4000). Native Node.js HTTP — no Express.

| Method | Route | Auth | Purpose |
| ------ | ----- | ---- | ------- |
| `POST` | `/auth/privy` | None | Verify Privy token → JWT; optional `telegramChatId` links Telegram session |
| `GET` | `/intent/:intentId` | JWT | Fetch intent + execution status |
| `GET` | `/portfolio` | JWT | On-chain balances for user's SCA |
| `GET` | `/tokens?chainId=` | None | List verified tokens for a chain |
| `POST` | `/tools` | JWT | Register a dynamic tool manifest |
| `GET` | `/tools` | None | List active tool manifests |
| `DELETE` | `/tools/:toolId` | JWT | Deactivate a tool manifest |
| `POST` | `/http-tools` | JWT | Register an HTTP query tool with encrypted headers |
| `GET` | `/http-tools` | JWT | List user's registered HTTP query tools |
| `DELETE` | `/http-tools/:id` | JWT | Delete an HTTP query tool |
| `GET` | `/user/profile` | JWT | Fetch user profile (SCA, session key, privyDid) |
| `POST` | `/persistent` | None | Persist a session delegation record |
| `GET` | `/permissions?public_key=` | None | Fetch delegation record by session key address |
| `GET` | `/delegation/pending` | JWT | Fetch latest pending delegation |
| `POST` | `/delegation/:id/signed` | JWT | Mark a pending delegation as signed |
| `GET` | `/events` | JWT / `?token=` | SSE stream — `sign_request` events |
| `POST` | `/sign-response` | JWT | Submit txHash or rejection for a signing request |

## Telegram commands

| Command | Behavior |
| ------- | -------- |
| `/start` | Welcome; prompts auth if not logged in |
| `/auth <token>` | Links Privy token to chat (fallback; Mini App users auto-linked via `POST /auth/privy`) |
| `/logout` | Deletes session from DB + cache |
| `/new` | Clears active conversation |
| `/history` | Last 10 messages of current conversation |
| `/confirm` | Execute latest `AWAITING_CONFIRMATION` intent |
| `/cancel` | Abort pending intent |
| `/portfolio` | On-chain token balances for user's SCA |
| `/wallet` | SCA address + session key status |
| `/sign <to> <wei> <data> <desc>` | Creates signing request; pushes via SSE |
| _(text)_ | Chat + tool calls (web search, executeIntent, getPortfolio, system tools) |
| _(photo)_ | Vision chat with caption |

## Intent / message flow

```text
message:text
  ├─ token_disambig? → handleDisambiguationReply → resume phase 3/4
  ├─ no session + command → startCommandSession → compileSchema (Phase 2)
  ├─ no session + free text → startLegacySession → classifyIntent → selectTool → compileSchema
  └─ compile stage → continueCompileLoop (Phase 2 resumed)
                          ↓
                    finishCompileOrResolve (Phase 2→3 validation)
                          ↓
              ┌─────────────────────────┐
         dual-schema               legacy
         runResolutionPhase    resolveTokensAndFinish  (Phase 3)
              └─────────────────────────┘
                          ↓
               buildAndShowConfirmation  (Phase 4)
               user: /confirm → confirmAndExecute()
                  1. Rebuild calldata via solver
                  2. UserOpBuilder.submit() → userOpHash
                  3. waitForReceipt() → txHash
                  4. Save intent_executions + fee_records
                  5. TxResultParser → human string
                  6. notifyRecipient() if P2P transfer
```

Key notes: auth gate runs first; fiat shortcuts (`$5`, `N usdc`) auto-inject USDC if no `fromTokenSymbol` extracted; `@handle` recipients resolved via MTProto before confirmation.

## Database schema

| Table | Purpose |
| ----- | ------- |
| `users` | Account record |
| `telegram_sessions` | Telegram chat ID → userId + JWT expiry |
| `conversations` | Per-user threads |
| `messages` | All turns (user / assistant / tool / assistant_tool_call) |
| `user_profiles` | SCA address, session key, scope, status, privyDid |
| `token_registry` | Symbol → address + decimals per chainId |
| `intents` | Parsed intent records with status lifecycle |
| `intent_executions` | Per-attempt records with userOpHash + txHash |
| `tool_manifests` | Dynamic tool registry — slug, steps (JSON), inputSchema, chainIds |
| `fee_records` | 1% protocol fee audit trail |
| `http_query_tools` | Developer-registered HTTP tools — name, endpoint, method |
| `http_query_tool_headers` | AES-256-GCM encrypted headers for HTTP tools |

## Environment variables

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `DATABASE_URL` | `postgres://localhost/aether_intent` | PostgreSQL |
| `OPENAI_API_KEY` | — | OpenAI (LLM + embeddings) |
| `OPENAI_MODEL` | `gpt-4o` | LLM model |
| `ANTHROPIC_API_KEY` | — | Unused orchestrator (kept for fallback) |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot |
| `JWT_SECRET` | — | JWT signing |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `HTTP_API_PORT` | `4000` | HTTP server port |
| `TAVILY_API_KEY` | — | Web search |
| `MAX_TOOL_ROUNDS` | `10` | Max agentic tool rounds per chat |
| `RPC_URL` | resolved from `CHAIN_ID` | EVM chain RPC endpoint |
| `BUNDLER_URL` | — | ERC-4337 bundler (e.g. Pimlico) |
| `BOT_PRIVATE_KEY` | — | Session key signer |
| `BOT_ADDRESS` | — | On-chain address of BOT_PRIVATE_KEY |
| `TREASURY_ADDRESS` | — | Protocol fee recipient |
| `CHAIN_ID` | `43113` | 43113 = Fuji, 43114 = Mainnet |
| `ENTRY_POINT_ADDRESS` | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | ERC-4337 EntryPoint |
| `JARVIS_ACCOUNT_FACTORY_ADDRESS` | `0x160E43075D9912FFd7006f7Ad14f4781C7f0D443` | SCA factory |
| `SESSION_KEY_MANAGER_ADDRESS` | `0xA5264f7599B031fDD523Ab66f6B6FA86ce56d291` | Session key manager |
| `REWARD_CONTROLLER_ADDRESS` | — | ClaimRewardsSolver contract |
| `TRADERJOE_API_URL` | `https://api.traderjoexyz.com` | TraderJoe quote API |
| `PANGOLIN_TOKEN_LIST_URL` | Pangolin GitHub raw | Token list source override |
| `TOKEN_CRAWLER_INTERVAL_MS` | `900000` | Token list re-fetch interval |
| `REDIS_URL` | — | Redis connection string |
| `TG_API_ID` | — | MTProto API ID |
| `TG_API_HASH` | — | MTProto API hash |
| `TG_SESSION` | `""` | Persisted gramjs session |
| `PRIVY_APP_ID` | — | Privy app ID |
| `PRIVY_APP_SECRET` | — | Privy app secret |
| `PINECONE_API_KEY` | — | Pinecone (tool index) |
| `PINECONE_INDEX_NAME` | — | Pinecone index name |
| `PINECONE_HOST` | — | Pinecone index host URL |
| `HTTP_TOOL_HEADER_ENCRYPTION_KEY` | — | 32-byte hex key for AES-256-GCM |

## Coding conventions

- IDs: `newUuid()`. Timestamps: `newCurrentUTCEpoch()` — **seconds**, not ms.
- Comments only where code cannot explain itself. No JSDoc, no section dividers.
- DB facade: `assistant.di.ts` holds `DrizzleSqlDB`; repos are properties on it.
- Migrations: always `npm run db:generate && npm run db:migrate`. Never raw SQL.

## Patterns

**New system tool** (free, in-memory): implement `ITool` in `output/tools/system/` → add to `SystemToolProviderConcrete.getTools()`.

**New developer HTTP tool** (DB-registered): user POSTs to `/http-tools`; loaded at runtime in `registryFactory`. Headers stored AES-256-GCM encrypted.

**New tool (other):** add to `TOOL_TYPE` enum → implement `ITool` in `output/tools/` → register in `registryFactory`.

**New DB table:** `schema.ts` → repo interface → Drizzle impl → add to `DrizzleSqlDB` → wire in `assistant.di.ts` → `npm run db:generate && npm run db:migrate`.

**New solver:** implement `ISolver` in `output/solver/static/` or `restful/` → register in `getSolverRegistry()`.

**Swap wallet provider:** new file in `output/walletData/` implementing `IWalletDataProvider` → one line change in `assistant.di.ts`.
