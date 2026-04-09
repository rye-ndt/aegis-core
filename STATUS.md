# Onchain Agent — Status

> Last updated: 2026-04-09 (token enrichment)

---

## Vision

A non-custodial, intent-based AI trading agent on Avalanche. Users state natural language intents (e.g., "Buy $100 of AVAX"), the AI parses the intent, and the bot executes the on-chain swap via an ERC-4337 Smart Account using Session Key delegation.

The user never holds a private key. The bot's Master Session Key signs `UserOperation`s on their behalf, authorized by their smart account. Every execution automatically routes a 1% protocol fee to the treasury.

---

## What it is (current implementation)

A fully wired intent-based AI trading agent on Telegram backed by Hexagonal Architecture. Users authenticate via JWT (register/login via HTTP API, then `/auth <token>` in Telegram). The agent can answer questions, execute web searches, parse trading intents, simulate them via ERC-4337 UserOperations, and submit them on-chain via Session Keys.

**Phase 1 (purge) ✅ — Phase 2 (infrastructure) ✅ — Phase 3 (execution engine) ✅ — Phase 4 (token crawler) ✅ — Phase 5 (token enrichment) ✅**

---

## Tech stack

| Layer          | Choice                                                        |
| -------------- | ------------------------------------------------------------- |
| Language       | TypeScript 5.3, Node.js, strict mode                          |
| Interface      | Telegram (`grammy`) + HTTP API (native `http`)                |
| ORM            | Drizzle ORM + PostgreSQL (`pg` driver)                        |
| LLM            | Anthropic Claude (`claude-sonnet-4-6`) via `@anthropic-ai/sdk` |
| Blockchain     | `viem` ^2 — public + wallet clients                           |
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
│   │   ├── auth.usecase.ts         # register() → deploys SCA + grants session key
│   │   ├── intent.usecase.ts       # parseAndExecute() → confirmAndExecute()
│   │   └── tokenIngestion.usecase.ts # ingest() — fetch → map → upsert token registry
│   └── interface/
│       ├── input/                  # IAssistantUseCase, IAuthUseCase, IIntentUseCase,
│       │                           # ITokenIngestionUseCase
│       └── output/                 # Outbound ports
│           ├── blockchain/         # ISmartAccountService, ISessionKeyService,
│           │                       # IUserOperationBuilder, IPaymasterService
│           ├── solver/             # ISolver, ISolverRegistry
│           ├── repository/         # 9 repo interfaces (users → feeRecords)
│           ├── intentParser.interface.ts   # IntentPackage, SimulationReport
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
│       │   ├── http/              # HttpApiServer — /auth/*, /intent/:id, /portfolio, /tokens
│       │   ├── jobs/              # TokenCrawlerJob — driving adapter, fires on timer
│       │   └── telegram/          # TelegramBot, TelegramAssistantHandler
│       │
│       └── output/
│           ├── orchestrator/
│           │   ├── anthropic.ts   # AnthropicOrchestrator (active)
│           │   └── openai.ts      # OpenAIOrchestrator (kept, unused)
│           ├── blockchain/        # viemClient, smartAccount, sessionKey,
│           │                      # userOperation.builder, paymaster
│           ├── solver/
│           │   ├── solverRegistry.ts
│           │   ├── static/claimRewards.solver.ts
│           │   └── restful/traderJoe.solver.ts
│           ├── simulator/         # rpc.simulator.ts — viem eth_call simulation
│           ├── intentParser/      # anthropic.intentParser.ts — LLM → IntentPackage
│           ├── tokenRegistry/     # db.tokenRegistry.ts
│           ├── tokenCrawler/      # pangolin.tokenCrawler.ts (ITokenCrawlerJob)
│           ├── resultParser/      # tx.resultParser.ts — receipt → human string
│           ├── webSearch/         # TavilyWebSearchService
│           ├── tools/
│           │   ├── webSearch.tool.ts
│           │   ├── executeIntent.tool.ts   # LLM triggers intent parse+execute
│           │   └── getPortfolio.tool.ts    # Reads SCA on-chain balances
│           ├── toolRegistry.concrete.ts
│           └── sqlDB/             # DrizzleSqlDB + 10 repositories
│
└── helpers/
    ├── enums/                     # TOOL_TYPE, MESSAGE_ROLE, USER_STATUSES,
    │                              # CONVERSATION_STATUSES, INTENT_STATUSES,
    │                              # EXECUTION_STATUSES, SESSION_KEY_STATUSES,
    │                              # SOLVER_TYPE
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

| Method | Route              | Auth   | Purpose                                            |
| ------ | ------------------ | ------ | -------------------------------------------------- |
| `POST` | `/auth/register`   | None   | Create account + deploy SCA; returns `{ userId }`  |
| `POST` | `/auth/login`      | None   | Returns `{ token, expiresAtEpoch, userId }`        |
| `GET`  | `/intent/:intentId`| JWT    | Fetch intent + execution status                    |
| `GET`  | `/portfolio`       | JWT    | On-chain balances for user's SCA                   |
| `GET`  | `/tokens?chainId=` | None   | List verified tokens for a chain                   |

---

## Telegram commands

| Command         | Behavior                                                                 |
| --------------- | ------------------------------------------------------------------------ |
| `/start`        | Welcome message; prompts authentication if not logged in                 |
| `/auth <token>` | Links JWT to this Telegram chat; persists to `telegram_sessions`         |
| `/logout`       | Deletes session from DB + cache                                          |
| `/new`          | Clears active conversation ID (starts fresh thread)                      |
| `/history`      | Shows last 10 messages of the current conversation                       |
| `/confirm`      | Executes the latest `AWAITING_CONFIRMATION` intent                       |
| `/cancel`       | Aborts the pending intent (no tx submitted)                              |
| `/portfolio`    | Shows on-chain token balances for user's SCA                             |
| `/wallet`       | Shows SCA address + session key status                                   |
| _(text)_        | Chat with the agent; supports tool calls (web search, executeIntent, getPortfolio) |
| _(photo)_       | Base64 → vision chat with caption as message                             |

---

## Intent execution flow

```text
User message: "Swap 100 USDC for AVAX"
      │
      ▼
AssistantUseCaseImpl.chat()
  → LLM decides to call executeIntent tool
      │
      ▼
IntentUseCaseImpl.parseAndExecute()
  1. AnthropicIntentParser.parse()     → IntentPackage (JSON)
  2. TokenRegistry.resolve()           → fill addresses + decimals
  3. Confidence check (< 0.7 → reject)
  4. SolverRegistry.getSolver("swap")  → TraderJoeSolver
  5. solver.buildCalldata()            → { to, data, value }
  6. UserOpBuilder.build()             → IUserOperation
  7. RpcSimulator.simulate()           → SimulationReport
  8. If !passed → SIMULATION_FAILED, return summary
  9. Save intent(AWAITING_CONFIRMATION) to DB
 10. Return pre-flight summary + "Type /confirm to execute"

User sends /confirm
      │
      ▼
IntentUseCaseImpl.confirmAndExecute()
 11. Rebuild calldata + UserOp
 12. UserOpBuilder.submit()            → { userOpHash }
 13. UserOpBuilder.waitForReceipt()    → { txHash, success }
 14. Save intent_executions + fee_records to DB
 15. TxResultParser.parse()            → human success string
 16. Return { status: COMPLETED, txHash, humanSummary }
```

---

## Database schema

| Table               | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `users`             | Account record — hashed password, email, status                     |
| `telegram_sessions` | Links Telegram chat ID → userId with JWT expiry                      |
| `conversations`     | Per-user threads — title, status                                     |
| `messages`          | All turns (user / assistant / tool / assistant_tool_call)            |
| `user_profiles`     | SCA address, session key address + scope + status                    |
| `token_registry`    | Symbol → address + decimals per chainId; `deployer_address` nullable  |
| `intents`           | Parsed intent records with status lifecycle                          |
| `intent_executions` | Per-attempt execution records with userOpHash + txHash               |
| `tool_manifests`    | Solver registry with rev-share metadata                              |
| `fee_records`       | Audit trail of every 1% protocol fee collected                       |

---

## Pivot roadmap

### Phase 1 — Purge ✅
Removed: RLHF data logging, AGS reward logic, evaluation logs, user memory (vector DB + Pinecone), Google Calendar/Gmail tools, reminder crawlers, TTS/STT, personality customization, todo system, jarvisConfig, orphaned dead code.

### Phase 2 — Core infrastructure ✅
- [x] Swap OpenAI orchestrator → `AnthropicOrchestrator` (Claude Sonnet 4.6)
- [x] Wire `SmartAccountAdapter` in `auth.usecase.ts` — deploys SCA + grants session key on `/register`
- [x] New DB: `aether_intent` with 5 new tables + extended `user_profiles`
- [x] All new repository interfaces + Drizzle implementations
- [x] `ViemClientAdapter` — shared public + wallet clients

### Phase 3 — Execution engine ✅
- [x] `AnthropicIntentParser` — LLM → strict `IntentPackage` JSON with Zod validation
- [x] `TokenRegistry` — DB-backed symbol → address resolver + chain filter
- [x] `SolverRegistry` + `ClaimRewardsSolver` (static) + `TraderJoeSolver` (REST)
- [x] `RpcSimulator` — `eth_call` simulation, revert detection
- [x] `UserOperationBuilder` — nonce fetch, gas estimation, bundler submit, receipt poll
- [x] `IntentUseCaseImpl` — full parse → simulate → confirm → execute flow
- [x] `TxResultParser` — receipt → human success string
- [x] `ExecuteIntentTool` + `GetPortfolioTool` registered in DI
- [x] Protocol fee: 1% auto-routed to treasury, fee_record written per execution
- [x] Telegram: `/confirm`, `/cancel`, `/portfolio`, `/wallet` commands
- [x] HTTP API: `/intent/:id`, `/portfolio`, `/tokens` endpoints

### Phase 4 — Token crawler ✅
- [x] `token_registry` schema extended with `deployer_address` (nullable text); migration `0012_gigantic_psynapse`
- [x] Port interface `ITokenCrawlerJob` + `CrawledToken` in `use-cases/interface/output/tokenCrawler.interface.ts`
- [x] `PangolinTokenCrawler` — fetches Pangolin token list, filters by chainId, uppercases symbols; URL overridable via `PANGOLIN_TOKEN_LIST_URL`
- [x] `TokenIngestionUseCase` — owns business logic: maps `CrawledToken` → `TokenRecordInit`, enforces `isVerified=false`, upserts via `ITokenRegistryDB`
- [x] `TokenCrawlerJob` — driving adapter in `adapters/input/jobs/`; owns `setInterval`; calls use-case only; interval configurable via `TOKEN_CRAWLER_INTERVAL_MS` (default 15 min)
- [x] DI: `getTokenCrawlerJob()` in `AssistantInject`; `getChainId()` private helper eliminates duplicated `parseInt(CHAIN_ID)`
- [x] Boot: crawler fires immediately on `npm run dev`, then every 15 min; stopped cleanly on SIGINT

### Phase 5 — Token enrichment ✅
- [x] `ITokenRegistryDB.searchBySymbol(pattern, chainId)` — case-insensitive ILIKE on both `symbol` and `name` columns (OR); deduplicates by returning all matches
- [x] `DrizzleTokenRegistryRepo.searchBySymbol` — uses `ilike` + `or` from drizzle-orm; no `toUpperCase` needed since ILIKE handles case
- [x] `ITokenRegistryService.searchBySymbol` + `DbTokenRegistryService.searchBySymbol` — thin service layer pass-through
- [x] `TelegramAssistantHandler` rewrite:
  - `DisambiguationPending` state type + `tokenDisambiguation: Map<number, DisambiguationPending>`
  - `message:text` handler routes to `handleDisambiguationReply` when disambiguation is pending
  - `startTokenResolution` — searches both from/to tokens; shows disambiguation prompt if >1 match, errors if 0, resolves immediately if exactly 1
  - `handleDisambiguationReply` — handles sequential from→to disambiguation; non-numeric reply cancels and prompts retry
  - `buildDisambiguationPrompt` — plain text numbered list: symbol, name, truncated address, decimals
  - `buildEnrichedMessage` — Markdown summary with token address/decimals, BigInt `amountRaw` for fromToken, JSON intent block appended
  - `toRaw()` module-level helper — BigInt string arithmetic, no float precision loss on 18-decimal tokens
  - `/cancel` also clears `tokenDisambiguation`
- [x] `validateIntent` wired into `message:text` handler — called after `parse`, inside the same try/catch; history preserved on `MissingFieldsError`/`InvalidFieldError` for multi-turn; only cleared on full validation pass
- [x] `telegramCli.ts` — wired `tokenRegistryService` and `chainId` into `TelegramAssistantHandler` constructor (were `undefined`)

### Next steps
- [ ] Run `drizzle/seed/tokenRegistry.ts` — seed AVAX/WAVAX/USDC for Fuji
- [ ] Fill `.env` with `ANTHROPIC_API_KEY`, `BOT_PRIVATE_KEY`, `AVAX_BUNDLER_URL`, `TREASURY_ADDRESS`, `BOT_ADDRESS`
- [ ] Integration test: register → SCA deployed → "Swap 100 USDC for AVAX" → /confirm → txHash

---

## Environment variables

| Variable                           | Default                          | Purpose                                   |
| ---------------------------------- | -------------------------------- | ----------------------------------------- |
| `DATABASE_URL`                     | `postgres://localhost/aether_intent` | PostgreSQL connection string          |
| `ANTHROPIC_API_KEY`                | —                                | Anthropic API key                         |
| `ANTHROPIC_MODEL`                  | `claude-sonnet-4-6`              | LLM model                                 |
| `TELEGRAM_BOT_TOKEN`               | —                                | Telegram bot token                        |
| `JWT_SECRET`                       | —                                | JWT signing secret                        |
| `JWT_EXPIRES_IN`                   | `7d`                             | Token lifetime                            |
| `HTTP_API_PORT`                    | `4000`                           | HTTP API port                             |
| `TAVILY_API_KEY`                   | —                                | Tavily web search key                     |
| `MAX_TOOL_ROUNDS`                  | `10`                             | Max agentic tool rounds per chat          |
| `AVAX_RPC_URL`                     | Fuji public RPC                  | Avalanche RPC endpoint                    |
| `AVAX_BUNDLER_URL`                 | —                                | ERC-4337 bundler (e.g. Pimlico)           |
| `BOT_PRIVATE_KEY`                  | —                                | Session key signer private key            |
| `BOT_ADDRESS`                      | —                                | On-chain address of BOT_PRIVATE_KEY       |
| `TREASURY_ADDRESS`                 | —                                | Platform fee recipient wallet             |
| `CHAIN_ID`                         | `43113`                          | 43113 = Fuji, 43114 = Mainnet             |
| `ENTRY_POINT_ADDRESS`              | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | ERC-4337 EntryPoint      |
| `JARVIS_ACCOUNT_FACTORY_ADDRESS`   | `0x160E43075D9912FFd7006f7Ad14f4781C7f0D443` | SCA factory              |
| `SESSION_KEY_MANAGER_ADDRESS`      | `0xA5264f7599B031fDD523Ab66f6B6FA86ce56d291` | Session key manager      |
| `REWARD_CONTROLLER_ADDRESS`        | —                                | Rewards contract for ClaimRewardsSolver   |
| `TRADERJOE_API_URL`                | `https://api.traderjoexyz.com`   | TraderJoe quote API                       |
| `PANGOLIN_TOKEN_LIST_URL`          | Pangolin GitHub raw URL          | Override Pangolin token list source       |
| `TOKEN_CRAWLER_INTERVAL_MS`        | `900000` (15 min)                | How often to re-fetch token list          |

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

### Adding a new token crawler source

1. Create `src/adapters/implementations/output/tokenCrawler/mySource.tokenCrawler.ts` implementing `ITokenCrawlerJob`.
2. In `AssistantInject.getTokenCrawlerJob()`, swap `new PangolinTokenCrawler()` for the new impl, or compose multiple crawlers behind a `MultiSourceTokenCrawler` that merges results before passing to `TokenIngestionUseCase`.
3. No other files need to change.

### Adding a new solver

1. Implement `ISolver` in `src/adapters/implementations/output/solver/static/` or `restful/`.
2. Register it in `AssistantInject.getSolverRegistry()` with the action string key.
