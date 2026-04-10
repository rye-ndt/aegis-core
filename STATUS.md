# Onchain Agent — Status

> Last updated: 2026-04-10 (tool RAG indexing — in progress, uncommitted)

---

## Vision

A non-custodial, intent-based AI trading agent on Avalanche. Users state natural language intents (e.g., "Buy $100 of AVAX"), the AI parses the intent, and the bot executes the on-chain swap via an ERC-4337 Smart Account using Session Key delegation.

The user never holds a private key. The bot's Master Session Key signs `UserOperation`s on their behalf, authorized by their smart account. Every execution automatically routes a 1% protocol fee to the treasury.

---

## What it is (current implementation)

A fully wired intent-based AI trading agent on Telegram backed by Hexagonal Architecture. Users authenticate via JWT (register/login via HTTP API, then `/auth <token>` in Telegram). The agent can answer questions, execute web searches, parse trading intents, simulate them via ERC-4337 UserOperations, and submit them on-chain via Session Keys.

**Phase 1 (purge) ✅ — Phase 2 (infrastructure) ✅ — Phase 3 (execution engine) ✅ — Phase 4 (token crawler) ✅ — Phase 5 (token enrichment) ✅ — Phase 6 (dynamic tool registry) ✅ — Phase 7 (tool RAG indexing) 🚧**

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
│   │   ├── tokenIngestion.usecase.ts # ingest() — fetch → map → upsert token registry
│   │   └── toolRegistration.usecase.ts # register() + list() — Zod validation, collision check
│   └── interface/
│       ├── input/                  # IAssistantUseCase, IAuthUseCase, IIntentUseCase,
│       │                           # ITokenIngestionUseCase, IToolRegistrationUseCase
│       └── output/                 # Outbound ports
│           ├── blockchain/         # ISmartAccountService, ISessionKeyService,
│           │                       # IUserOperationBuilder, IPaymasterService
│           ├── solver/             # ISolver, ISolverRegistry (async getSolverAsync)
│           ├── repository/         # 9 repo interfaces (users → feeRecords)
│           ├── intentParser.interface.ts   # IntentPackage (action: string, params?), SimulationReport
│           ├── toolManifest.types.ts       # ToolManifest Zod schemas + deserializeManifest
│           ├── toolIndex.interface.ts      # IToolIndexService (index, search, delete)
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
│           ├── tools/
│           │   ├── webSearch.tool.ts
│           │   ├── executeIntent.tool.ts   # LLM triggers intent parse+execute
│           │   └── getPortfolio.tool.ts    # Reads SCA on-chain balances
│           ├── toolIndex/
│           │   └── pinecone.toolIndex.ts   # PineconeToolIndexService (IToolIndexService)
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
| `POST` | `/tools`           | JWT    | Register a dynamic tool manifest                   |
| `GET`  | `/tools`           | None   | List active tool manifests                         |

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

## System flow — user prompt to on-chain action

This section describes the full journey from the moment a user types a message to the point where a transaction lands on-chain. Each layer hands off to the next; no layer skips another.

### 1. User sends a message

The user types a natural language prompt in Telegram (e.g. *"Swap 100 USDC for AVAX"*) or calls the HTTP API. The **Telegram bot** or **HTTP handler** forwards the text to the **AssistantUseCase**.

### 2. LLM conversation loop

The **AnthropicOrchestrator** sends the message (plus the full conversation history) to Claude. Claude decides whether to answer conversationally or invoke one of its registered tools. For trading actions it invokes `execute_intent`. This loop runs up to `MAX_TOOL_ROUNDS` times — Claude can call web-search, portfolio reads, and intent execution in the same turn.

### 3. Intent parsing

`ExecuteIntentTool` calls **IntentUseCaseImpl.parseAndExecute()**. The first step is parsing: **AnthropicIntentParser** sends the last few messages to Claude in structured-output mode and gets back a strict JSON `IntentPackage` — action, tokens, amount, slippage, confidence. If confidence is below 0.7 the request is rejected immediately.

### 4. Token resolution

The token symbols from the `IntentPackage` (e.g. `"USDC"`, `"AVAX"`) are looked up in the **TokenRegistry** (PostgreSQL). Each symbol resolves to a chain-specific contract address and decimal precision. If a symbol is ambiguous (multiple matches) the Telegram handler shows a disambiguation menu; the user picks a number and the flow restarts.

### 5. Solver selection

**SolverRegistry.getSolverAsync()** looks up the action string. Hardcoded solvers (`swap`, `claim_rewards`) are checked first. If nothing matches, the registry queries the **tool_manifests** table for a dynamic tool whose `toolId` equals the action string — and wraps it in a **ManifestDrivenSolver**.

### 6. Calldata construction

The solver's `buildCalldata()` runs. For a **ManifestDrivenSolver** this executes the tool's step pipeline sequentially: HTTP calls fetch quotes, ABI-encode steps produce calldata, template expressions (`{{intent.amountHuman}}`) resolve against the intent context. The final step must produce `{ to, data, value }` — the raw EVM transaction payload.

### 7. Pre-flight simulation

The calldata is wrapped in a **UserOperation** (ERC-4337) and sent to `eth_call` via **RpcSimulator**. The simulator decodes token deltas and checks for reverts. If the simulation fails, the intent is marked `SIMULATION_FAILED` and the user gets a human-readable explanation — no gas is consumed.

### 8. Confirmation gate

If simulation passes, the intent is saved to the database with status `AWAITING_CONFIRMATION`. The user receives a pre-flight summary: what goes in, what comes out, estimated gas. They must type `/confirm` (Telegram) or call `POST /intent/:id/confirm` (API) to proceed.

### 9. On-chain submission

**UserOpBuilder.submit()** signs the `UserOperation` with the bot's **Session Key** and sends it to the ERC-4337 bundler. The bundler broadcasts it to the network. The builder polls for the receipt until the transaction is mined or times out.

### 10. Fee collection & result

After the transaction lands, a 1% protocol fee is recorded in `fee_records`. **TxResultParser** translates the raw receipt into a human string (*"Swapped 100 USDC → 0.42 AVAX. txHash: 0xabc…"*). The intent status is updated to `COMPLETED`. The result is returned up the call stack and displayed to the user.

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
  4. SolverRegistry.getSolverAsync("swap") → TraderJoeSolver (hardcoded) or ManifestDrivenSolver (DB)
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
| `tool_manifests`    | Dynamic tool registry — toolId slug, category, steps (JSON), inputSchema, chainIds |
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

### Phase 6 — Dynamic Tool Registry ✅
- [x] `TOOL_CATEGORY` enum (`erc20_transfer`, `swap`, `contract_interaction`)
- [x] `ToolManifestSchema` — Zod discriminated-union step schemas + `deserializeManifest()`
- [x] `IntentPackage.action` widened to `string`; `params?` added; `relevantManifests?` on `IIntentParser.parse()`
- [x] `tool_manifests` table rewrite — migration `0013_dynamic_tool_registry`; new columns: `tool_id`, `category`, `protocol_name`, `tags`, `priority`, `is_default`, `steps`, `preflight_preview`, `revenue_wallet`, `is_verified`
- [x] `IToolManifestDB` — new interface: `create`, `findByToolId`, `findById`, `listActive`, `deactivate`, `search()`
- [x] `DrizzleToolManifestRepo` — full rewrite; `search()` uses `ilike` OR across name/description/protocolName/tags; DB-level chainId filter via ilike
- [x] `ToolRegistrationUseCase` — Zod validation → reserved-id guard → collision check → abi_encode address validation → serialize → DB create
- [x] `templateEngine.ts` — `{{x.y.z}}` resolver; `TemplateResolutionError`; no eval
- [x] `stepExecutors.ts` — `http_get`, `http_post`, `abi_encode`, `calldata_passthrough`, `erc20_transfer` executors; minimal JSONPath (`$.field`, `$.nested.field`)
- [x] `ManifestDrivenSolver` — implements `ISolver`; sequential step pipeline; `ctx.steps[name]` accumulation
- [x] `SolverRegistry` — `getSolver` → `getSolverAsync`; hardcoded-first then DB fallback via `ManifestDrivenSolver`
- [x] `intent.validator.ts` — `manifest?` param; dynamic `inputSchema.required` check when provided
- [x] **Part 3** — `IntentUseCaseImpl` discovery pipeline (`discoverRelevantTools`, `resolveConflicts`), HTTP API (`POST /tools`, `GET /tools`), `assistant.di.ts` full wiring; `OpenAIIntentParser` accepts `relevantManifests?` param (ignored — discovery is use-case responsibility)

### Phase 7 — Tool RAG Indexing 🚧
> Plan: `constructions/tool-rag-indexing-plan.md`. Changes are in the working tree (uncommitted).

Replaces the naive ILIKE `discoverRelevantTools()` with Pinecone semantic search. Falls back to ILIKE when the index is unavailable.

- [x] `IToolIndexService` — new port: `index(id, toolId, text, category, chainIds)`, `search(query, {topK, chainId?, minScore?})`, `delete(id)`
- [x] `PineconeToolIndexService` — composes `IEmbeddingService` + `IVectorStore`; client-side chainId post-filter (Pinecone lacks `$in`); fetches `topK × 3` then slices after filtering; `minScore` default 0.3
- [x] `IToolManifestDB` extended with `findByToolIds(toolIds: string[])` — batch fetch, `isActive=true` only
- [x] `ToolRegistrationUseCase` — accepts optional `toolIndexService`; calls `index()` after DB create (best-effort; failure logs warning, never blocks registration); `RegisterToolResult` now includes `indexed: boolean`
- [x] `ToolRegistrationUseCase.deactivate()` — calls `toolIndexService.delete()` after DB deactivation (best-effort)
- [x] `IntentUseCaseImpl.discoverRelevantTools()` — vector-first: embed query → Pinecone → `findByToolIds` → `resolveConflicts`; falls back to ILIKE only on Pinecone error (not on 0 results)
- [ ] `DrizzleToolManifestRepo.findByToolIds()` — Drizzle impl of batch fetch (in progress, `toolManifest.repo.ts` modified)
- [ ] `assistant.di.ts` — wire `PineconeToolIndexService` into `ToolRegistrationUseCase` + `IntentUseCaseImpl` (in progress, `assistant.di.ts` modified)
- [ ] `PineconeVectorStore` — updated to support `delete(id)` (in progress, `vectorDB/pinecone.ts` modified)
- [ ] Integration test: `POST /tools` → `indexed: true`; intent message → vector hits returned; `DELETE /tools/:id` → vector removed

### Next steps
- [ ] Commit and finish Phase 7 wiring (`assistant.di.ts`, `DrizzleToolManifestRepo.findByToolIds`, `PineconeVectorStore.delete`)
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
