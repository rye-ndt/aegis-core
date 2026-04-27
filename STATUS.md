# Onchain Agent — Status

## What it is
Non-custodial, intent-based AI trading agent on Avalanche. Hexagonal Architecture (Ports & Adapters) — use-cases depend only on interfaces; assembly lives entirely in `src/adapters/inject/assistant.di.ts`. Users auth via Privy (Google or Telegram); Mini App passes `telegramChatId` to `POST /auth/privy` for session linking. Agent parses NL (incl. `$5` fiat shortcuts), classifies intent, compiles a tool input schema, resolves fields (tokens, amounts, Telegram handles), and executes via ERC-4337 UserOps through ZeroDev session keys. Telegram handles resolved via MTProto + Privy. Mini App polls `GET /request/:requestId` for pending auth/sign/approve work.

## Tech stack
| Layer | Choice |
|---|---|
| Language | TypeScript 5.3, Node.js, strict |
| Interface | Telegram (`grammy`) + HTTP API (native `node:http`) |
| ORM | Drizzle ORM + PostgreSQL (`pg`) |
| LLM | OpenAI (`gpt-4o` / configurable) |
| Blockchain | `viem` ^2 — any EVM chain (`CHAIN_ID`), ERC-4337 |
| Account Abs | ZeroDev SDK + `permissionless` ^0.2 |
| Validation | Zod 4.3.6 |
| DI | Manual container in `assistant.di.ts` |
| Web search | Tavily (`@tavily/core`) |
| Embeddings | OpenAI + Pinecone |
| Cache | Redis via `ioredis` |
| Telegram | `grammy` + `telegram` (gramjs / MTProto) |
| Auth | Privy (`@privy-io/server-auth`) — no backend JWTs |
| Cross-chain | Relay (`RELAY_API_URL`) |

## Important rules (non-negotiable)
1. **Hexagonal architecture.** Use-case layer imports only `use-cases/interface/`. Adapters import from `use-cases/interface/` and their own implementations. No adapter-to-adapter imports (`input/` ↔ `output/` cross-imports forbidden). No concrete classes in use-cases. Assembly only in `src/adapters/inject/assistant.di.ts`.
2. **No inline string literals for configuration.** All `process.env.X` reads hoisted to top-of-file `const`. Chain-specific values centralized in `src/helpers/chainConfig.ts` (`CHAIN_CONFIG`).
3. **No raw SQL outside Drizzle migrations.** Schema changes via `schema.ts` + `npm run db:generate && npm run db:migrate`.
4. **Privy-token-only auth.** `authUseCase.resolveUserId(token)` does `verifyTokenLite` + DB lookup. `Authorization: Bearer <privyToken>` (or `?token=` for SSE). No backend JWTs.
5. **Time is seconds.** Always `newCurrentUTCEpoch()`. IDs always `newUuid()` (v4).
6. **New features = new Capabilities.** Do not add flow logic to `handler.ts`.
7. **Backend never signs transactions.** All signing via user delegated session keys (mini-app). The legacy `BOT_PRIVATE_KEY` / `IUserOpExecutor` path was removed 2026-04-24 — do not reintroduce.

## Project structure
```text
src/
├── entrypoint.ts                  # Production entry — runs migrate, dispatches by PROCESS_ROLE
├── telegramCli.ts                 # Combined dev entry — HTTP + Telegram + jobs
├── workerCli.ts                   # Worker entry (PROCESS_ROLE=worker) — bot + jobs
├── httpCli.ts                     # API entry (PROCESS_ROLE=http) — HTTP only
├── migrate.ts                     # Drizzle migration runner
├── use-cases/
│   ├── implementations/           # assistant, auth, capabilityDispatcher, capabilityRegistry,
│   │                              # commandMapping, httpQueryTool, intent, loyalty, portfolio,
│   │                              # sessionDelegation, signingRequest, tokenIngestion,
│   │                              # toolRegistration, validateIntent, aegisGuardInterceptor,
│   │                              # yieldOptimizer, yieldPoolRanker
│   └── interface/
│       ├── input/                 # IAssistantUseCase, IAuthUseCase, ICapability,
│       │                          # ICapabilityDispatcher, ICommandMappingUseCase,
│       │                          # IHttpQueryToolUseCase, IIntentUseCase, ILoyaltyUseCase,
│       │                          # IPortfolioUseCase, ISessionDelegationUseCase,
│       │                          # ISigningRequestUseCase, ITokenIngestionUseCase,
│       │                          # IToolRegistrationUseCase, IYieldOptimizerUseCase,
│       │                          # intent.errors.ts (WINDOW_SIZE)
│       └── output/
│           ├── blockchain/        # IChainReader
│           ├── cache/             # IMiniAppRequestCache, miniAppRequest.types.ts,
│           │                      # ISessionDelegationCache, ISigningRequestCache,
│           │                      # IUserProfileCache
│           ├── delegation/        # IDelegationRequestBuilder, zerodevMessage.types.ts
│           ├── repository/        # 16 repos (users, telegramSessions, conversations, messages,
│           │                      # userProfiles, tokenRegistry, intents, intentExecutions,
│           │                      # toolManifests, pendingDelegations, feeRecords,
│           │                      # commandToolMappings, httpQueryTools, userPreferences,
│           │                      # tokenDelegations, loyalty)
│           ├── solver/            # ISolver, ISolverRegistry
│           ├── yield/             # IYieldProtocolAdapter, IYieldProtocolRegistry,
│           │                      # IYieldPoolRanker, IYieldRepository
│           ├── capabilityRegistry / paramCollector / artifactRenderer /
│           │  pendingCollectionStore (interfaces)
│           ├── embedding / executionEstimator / intentClassifier / intentParser /
│           │  orchestrator / privyAuth / relay / resolver / schemaCompiler / sqlDB /
│           │  systemToolProvider / telegramNotifier / telegramResolver / tokenCrawler /
│           │  tokenRegistry / tool / toolIndex / toolManifest.types / vectorDB /
│           │  walletDataProvider / webSearch (interfaces)
├── adapters/
│   ├── inject/assistant.di.ts     # Lazy-singleton wiring
│   └── implementations/
│       ├── input/
│       │   ├── http/httpServer.ts # exactRoutes + paramRoutes; /health; /metrics
│       │   ├── jobs/              # tokenCrawlerJob, yieldPoolScanJob, userIdleScanJob,
│       │   │                      # yieldReportJob
│       │   └── telegram/          # bot.ts, handler.ts (~200 LOC), bot notifier
│       └── output/
│           ├── orchestrator/openai.ts
│           ├── blockchain/viemClient.ts
│           ├── solver/
│           │   ├── solverRegistry.ts
│           │   ├── static/claimRewards.solver.ts
│           │   └── manifestSolver/  # templateEngine.ts, stepExecutors.ts, manifestDriven.solver.ts
│           ├── intentParser/      # openai.intentParser, openai.intentClassifier,
│           │                      # openai.schemaCompiler, deterministic.executionEstimator
│           ├── resolver/resolverEngine.ts  # per-field resolvers (incl. resolveTokenField)
│           ├── delegation/delegationRequestBuilder.ts
│           ├── privyAuth/privyServer.adapter.ts
│           ├── relay/relayClient.ts
│           ├── tokenRegistry/db.tokenRegistry.ts
│           ├── tokenCrawler/pangolin.tokenCrawler.ts
│           ├── webSearch/         # TavilyWebSearchService
│           ├── tools/             # webSearch, executeIntent, getPortfolio, httpQuery, relaySwap
│           │   └── system/        # transferErc20, walletBalances, transactionStatus,
│           │                      # gasSpend, rpcProxy
│           ├── walletData/privy.walletDataProvider.ts
│           ├── embedding/openai.ts
│           ├── vectorDB/pinecone.ts
│           ├── toolIndex/pinecone.toolIndex.ts
│           ├── cache/             # redis.miniAppRequest, redis.sessionDelegation,
│           │                      # redis.signingRequest, redis.userProfile
│           ├── pendingCollectionStore/  # inMemory.ts + redis.ts
│           ├── artifactRenderer/telegram.ts  # exhaustive Artifact switch
│           ├── capabilities/      # buyCapability, sendCapability, swapCapability,
│           │                      # yieldCapability, loyaltyCapability,
│           │                      # assistantChatCapability, send.messages, send.utils
│           ├── yield/aaveV3Adapter.ts
│           ├── telegram/          # botNotifier.ts, gramjs.telegramResolver.ts
│           ├── toolRegistry.concrete.ts
│           ├── systemToolProvider.concrete.ts
│           └── sqlDB/             # drizzleSqlDb.adapter.ts + schema.ts +
│                                  # 16 repositories
└── helpers/
    ├── chainConfig.ts             # CHAIN_REGISTRY, CHAIN_CONFIG, paymasterUrl, bundlerUrl,
    │                              # YieldChainConfig, getYieldConfig, getEnabledYieldChains,
    │                              # CAIP2_BY_PRIVY_NETWORK, RELAY_SUPPORTED_CHAIN_IDS,
    │                              # resolveChainSymbol, getChainRpcUrls
    ├── bigint.ts                  # wei conversions
    ├── uuid.ts                    # newUuid()
    ├── cache/redisResponseCache.ts # SHA1-keyed TTL helper
    ├── concurrency/openaiLimiter.ts # p-limit singleton (OPENAI_CONCURRENCY)
    ├── env/                       # role.ts (PROCESS_ROLE, isWorker), yieldEnv.ts, loyaltyEnv.ts
    ├── observability/             # logger.ts (pino), metricsRegistry.ts
    ├── loyalty/pointsFormula.ts   # computePointsV1
    ├── enums/                     # executionStatus, intentAction, intentCommand,
    │                              # intentStatus, messageRole, resolverField, sessionKeyStatus,
    │                              # statuses (USER/CONVERSATION_STATUSES, LOYALTY_STATUSES),
    │                              # toolCategory, toolType, userIntentType, zerodevMessageType,
    │                              # yieldProtocolId
    ├── crypto/aes.ts              # AES-256-GCM (iv:authTag:ciphertext)
    ├── errors/toErrorMessage.ts
    ├── schema/addressFields.ts
    └── time/dateTime.ts           # newCurrentUTCEpoch()
```

## Contract Registry (Avalanche Fuji)
- AegisToken (Proxy): `0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69`
- RewardController (Proxy): `0x519092C2185E4209B43d3ea40cC34D39978073A7`

## HTTP API
Runs on `HTTP_API_PORT` (default 4000). Native `node:http`. CORS allows all origins. Reqid `[API xxxxxxxx] →` from `newUuid().slice(0,8)`. Routing via `exactRoutes` + `paramRoutes`.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/health` | None | Deployment metadata (status, service, version, processRole, runtime, chain, uptime, memoryMb, services boolean map). No secrets/addresses/queue depths. |
| `POST` | `/auth/privy` | None | Verify token; upsert user + link Telegram session |
| `GET` | `/user/profile` | Privy | Cached user profile |
| `GET` | `/portfolio` | Privy | On-chain SCA balances |
| `GET` | `/yield/positions` | Privy | Live positions + totals (per `IYieldOptimizerUseCase.getPositions`) |
| `GET` | `/loyalty/balance` | Privy | `{ seasonId, pointsTotal:string, rank }` |
| `GET` | `/loyalty/history?limit=&cursorCreatedAtEpoch=` | Privy | `{ entries[], nextCursor }` |
| `GET` | `/loyalty/leaderboard?limit=&seasonId=` | None | Defaults `seasonId` to `getActiveSeasonId()` |
| `GET` | `/tokens?chainId=` | None | Verified tokens |
| `POST` `DELETE /:toolId` | `/tools` | Admin (`ADMIN_PRIVY_DIDS`) | Register/deactivate dynamic tool manifests |
| `GET` | `/tools` | None | List dynamic tool manifests |
| `GET` | `/permissions?public_key=` | Privy + ownership (caller's SCA must match `public_key`) | Session-key delegation by address |
| `GET` `POST /:id/signed` | `/delegation/pending` | Privy | ZeroDev message lifecycle |
| `GET` | `/request/:requestId` | None for `auth` type; Privy + ownership for `sign`/`approve`/`onramp` | Mini-app polls work items |
| `GET` | `/request/:requestId?after=<id>` | Privy | Next queued sign request for user (Redis ZSET `user_pending_signs:<userId>`) |
| `POST` | `/response` | mixed | Mini-app result; `auth` calls `loginWithPrivy` directly (no `resolveUserId` gate). Sign/approve keep ownership gate. |
| `POST` `DELETE /:command` | `/command-mappings` | Admin (`ADMIN_PRIVY_DIDS`) | Set/delete command → toolId mappings |
| `GET` | `/command-mappings` | None | List command → toolId mappings |
| `POST` `GET` `DELETE /:id` | `/http-tools` | Privy | HTTP query tools (AES-256-GCM headers) |
| `GET` `POST` | `/preference` | Privy | `aegisGuardEnabled` |
| `GET` | `/delegation/approval-params` | Privy | Default tokens + suggested limits |
| `GET` `POST` | `/delegation/grant` | Privy | List/upsert `token_delegations` |
| `GET` | `/metrics` | Bearer (`METRICS_TOKEN`) | pgPool/openai/redis/LLM metrics |

## Telegram commands
| Command | Behavior |
|---|---|
| `/start`, `/auth <token>`, `/logout`, `/new`, `/history`, `/confirm`, `/cancel`, `/portfolio`, `/wallet`, `/sign <to> <wei> <data> <desc>` | Auth + meta |
| `/buy`, `/sell`, `/convert`, `/topup`, `/dca`, `/send`, `/money` | Intent (SendCapability) |
| `/swap` | Relay (SwapCapability) |
| `/yield`, `/withdraw` | YieldCapability |
| `/points`, `/leaderboard` | LoyaltyCapability |
| _(text)_ | AssistantChatCapability — chat + tool calls |
| _(photo)_ | Vision chat with caption |

## Intent / message flow
```text
message:text
  ├─ token_disambig? → resume resolve phase
  ├─ slash command   → CapabilityDispatcher (priority: fresh match → resume pending → default)
  ├─ free text       → classifyIntent → toolIndex lookup → schemaCompiler
  └─ continue in-progress compile loop
                          ↓
                    schemaCompiler (fill required fields)
                          ↓
                    ResolverEngine (RESOLVER_FIELD: from/toTokenSymbol,
                      readableAmount, userHandle, etc.)
                          ↓
                    DeterministicExecutionEstimator (preview)
                          ↓
                    buildAndShowConfirmation
                          ↓
                    Capability creates SigningRequestRecord
                    (ISigningRequestUseCase.create) + emits mini_app artifact.
                    Mini-app polls /request/:id, signs with delegated session
                    key, POSTs /response. waitFor(requestId) resumes capability.
```
Auth gate first; fiat shortcuts (`$5`, `N usdc`) auto-inject USDC if no `fromTokenSymbol`; `@handle` → MTProto resolution before confirmation. `parseIntentCommand(text)` is the only slash-command matcher.

## Database schema
| Table | Purpose |
|---|---|
| `users` | `privyDid` unique, `status`, `email`, `loyalty_status` |
| `telegram_sessions` | chatId → userId + expiry |
| `conversations` | Per-user threads |
| `messages` | All turns (user/assistant/tool/assistant_tool_call) |
| `user_profiles` | SCA, EOA, session key, scope, status, telegramChatId |
| `token_registry` | symbol → addr+decimals per chainId |
| `intents`, `intent_executions` | Lifecycle + per-attempt records (userOpHash, txHash, fees) |
| `tool_manifests` | toolId, steps (JSON), inputSchema, chainIds, priority |
| `pending_delegations` | Queued ZeroDev messages awaiting signature |
| `fee_records` | Protocol fee audit trail |
| `command_tool_mappings` | bare word → toolId (soft FK) |
| `http_query_tools` + `http_query_tool_headers` | Developer HTTP tools (encrypted headers) |
| `user_preferences` | `aegisGuardEnabled` |
| `token_delegations` | `limitRaw`, `spentRaw`, `validUntil` per token |
| `yield_deposits`, `yield_withdrawals`, `yield_position_snapshots` | Yield positions |
| `loyalty_seasons`, `loyalty_action_types`, `loyalty_points_ledger` | Loyalty (DESC index on `points_raw`) |

## Redis key schema
| Key | Value | TTL |
|---|---|---|
| `delegation:{sessionKeyAddress}` (lowercased) | `DelegationRecord` | none |
| `sign_req:{id}` | signing request | `max(10s, expiresAt-now)`; `KEEPTTL` on resolve |
| `mini_app_req:{requestId}` | `MiniAppRequest` | 600s |
| `user_pending_signs:<userId>` (ZSET) | per-user index of pending sign requests | maintained by `RedisMiniAppRequestCache.store/delete` |
| `user_profile:{userId}` | `PrivyUserProfile` | per-call (min 10s) |
| `pending_collection:{channelId}` | `PendingCollection` | `min(expiresAt-now, 1h)` |
| `tavily:{sha1(q+limit)}` | search response | `TAVILY_CACHE_TTL_SECONDS` (300s) |
| `relay_quote:{sha1(user+route+amount+type)}` | RelayQuote | `RELAY_QUOTE_CACHE_TTL_SECONDS` (15s) |
| `yield:best:{chainId}:{token}` | `{protocolId,score,apy,ts}` | 3h |
| `yield:apy_series:{chainId}:{protocolId}:{token}` | list (84 samples) | none |
| `yield:nudge_cooldown:{userId}` | `"1"` | `YIELD_NUDGE_COOLDOWN_SEC` |
| `yield:nudge_pending:{userId}` | `"1"` | 48h |
| `yield:report_done:{YYYY-MM-DD}` | `"1"` | 25h |
| `loyalty:season:active` | active season JSON | 60s |
| `loyalty:leaderboard:{seasonId}:{limit}` | leaderboard JSON | 30s |

## Environment variables
| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost/aether_intent` | Postgres |
| `REDIS_URL` | — | Redis (optional — feature-gated adapters fall back to in-memory) |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | — / `gpt-4o` | LLM + embeddings |
| `OPENAI_CONCURRENCY` | `6` | Per-replica p-limit cap |
| `TELEGRAM_BOT_TOKEN`, `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` | — | Telegram + MTProto |
| `HTTP_API_PORT` | `4000` | (Cloud Run `PORT` remapped in `entrypoint.ts`) |
| `MINI_APP_URL` | — | Mini-app base URL |
| `CHAIN_ID` | `43113` | Resolved against `CHAIN_REGISTRY` (Fuji, C-Chain, 1, 8453, 137, 42161, 10) |
| `RPC_URL`, `RPC_URL_FALLBACKS` | from CHAIN_CONFIG / `""` | Primary + comma-separated fallbacks (viem `fallback([...])`, retryCount:1) |
| `AVAX_BUNDLER_URL`, `AVAX_PAYMASTER_URL` | — | Bundler + paymaster (also on `CHAIN_CONFIG`) |
| `REWARD_CONTROLLER_ADDRESS` | — | `ClaimRewardsSolver` target |
| `PANGOLIN_TOKEN_LIST_URL`, `TOKEN_CRAWLER_INTERVAL_MS` | / `900000` | Token list source + cadence |
| `DELEGATION_TTL_SECONDS` | `604800` | Default session-key lifetime |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | — | |
| `PRIVY_VERIFY_CACHE_TTL_MS`, `PRIVY_VERIFY_CACHE_MAX` | `300000` / `5000` | LRU verifyTokenLite cache |
| `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `PINECONE_HOST` | — | Tool index |
| `TAVILY_API_KEY`, `TAVILY_CACHE_TTL_SECONDS` | — / `300` | Web search + cache |
| `RELAY_API_URL`, `RELAY_QUOTE_CACHE_TTL_SECONDS` | `https://api.relay.link` / `15` | Cross-chain swap |
| `HTTP_TOOL_HEADER_ENCRYPTION_KEY` | — | 32-byte hex AES-256-GCM |
| `MAX_TOOL_ROUNDS`, `MESSAGE_HISTORY_LIMIT` | `10` / `30` | Assistant guardrails |
| `PROCESS_ROLE` | `combined` | `worker` \| `http` \| `combined` |
| `DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONNECTION_TIMEOUT_MS` | `25` / `30000` / `5000` | Postgres pool |
| `METRICS_TOKEN` | — | `/metrics` bearer (unset = disabled) |
| `ADMIN_PRIVY_DIDS` | — | Comma-separated Privy DIDs allowed to call `POST /tools`, `POST /command-mappings`, `DELETE /command-mappings/:command`. Unset = all admin routes return 403. |
| `LOG_LEVEL`, `LOG_PRETTY` | `info` (prod) / `debug` else; `false` | pino config |
| `SERVICE_VERSION` | `unknown` | Surfaced by `/health` |
| `YIELD_IDLE_USDC_THRESHOLD_USD` | `10` | Min idle to nudge |
| `YIELD_POOL_SCAN_INTERVAL_MS` | `7200000` | Pool scan |
| `YIELD_USER_SCAN_INTERVAL_MS` | `86400000` | Idle scan |
| `YIELD_REPORT_UTC_HOUR` | `9` | Daily report hour UTC |
| `YIELD_NUDGE_COOLDOWN_SEC` | `86400` | Cooldown between nudges |
| `YIELD_ENABLED_CHAIN_IDS` | `43114` | Comma-separated |
| `LOYALTY_ACTIVE_SEASON_CACHE_TTL_MS` | `60000` | |
| `LOYALTY_LEADERBOARD_CACHE_TTL_MS` | `30000` | |
| `LOYALTY_LEADERBOARD_DEFAULT_LIMIT`, `_MAX_LIMIT` | `100` / `1000` | |

## Coding conventions
- **IDs**: `newUuid()` only (UUID v4). Never `crypto.randomUUID()` or `Math.random()`.
- **Timestamps**: `newCurrentUTCEpoch()` — seconds. Columns end in `AtEpoch`/`at_epoch`. `Date.now()` only for ms-latency.
- **Config literals**: every `process.env.X` hoisted to top-of-file `const`. No `process.env` in a hot path.
- **Chain-specific values**: `chainConfig.ts` only — adding a chain = one `CHAIN_REGISTRY` entry.
- **Enums in `helpers/enums/`**: prefer enum value over inline string. `parseIntentCommand` is the only slash matcher.
- **Hexagonal discipline**: see rule 1 above. `MiniAppRequest`/`DelegationRecord` live under `interface/output/cache/` so both sides reference without coupling.
- **DB facade**: single `DrizzleSqlDB`; every repo hangs off as `db.users`, `db.toolManifests`, …. Use-cases receive the repo interface, never the facade.
- **Migrations**: always `npm run db:generate && npm run db:migrate`. Never raw SQL. **See "Drizzle migrations — handle with extreme care" below before touching anything in `drizzle/` or `schema.ts`.**
- **Validation at boundaries**: every HTTP body Zod-parsed. Shared validators in `helpers/schema/`.
- **Lazy singletons** in `AssistantInject`: `if (!this._x) this._x = new X(...); return this._x`. Optional-env services return `undefined` when unconfigured.
- **HTTP routing**: only `exactRoutes` (`"METHOD /path"`) or `paramRoutes` regex. Never if/else.
- **Comments**: only where code can't explain itself.
- **Encrypted secrets**: AES-256-GCM via `helpers/crypto/aes.ts`, stored as `iv:authTag:ciphertext` hex.

### Drizzle migrations — handle with extreme care

The `drizzle/` folder is **merge-hostile**. The `_journal.json` index, the per-migration `meta/*_snapshot.json` files, and the sequentially numbered `NNNN_*.sql` filenames all collide the moment two branches generate migrations independently. This repo has already been bitten by exactly that — there are dual `0016_*.sql` files, a missing `0019_*`, scrambled `idx` ordering in `meta/_journal.json`, and at least one merge silently dropped an `ALTER TABLE users ADD COLUMN privy_did` statement while leaving the snapshot intact. Login broke for everyone whose DB was on that branch because drizzle thought the schema was synced when it wasn't.

**Rules — apply on every change that touches schema:**

- **Always rebase onto the latest main before running `drizzle-kit generate`.** This guarantees the new migration slots cleanly after the current head and avoids number collisions.
- **Never hand-resolve a merge conflict inside `drizzle/`.** If git reports conflicts in `_journal.json`, any `*_snapshot.json`, or any `NNNN_*.sql` file: abort the merge, drop the local migration file(s), rebase, then regenerate with `drizzle-kit generate`. Hand-edits will silently desync the journal from the SQL from the snapshots.
- **Never delete or rename a migration that has been merged to main**, even if it looks redundant. Its hash lives in `drizzle.__drizzle_migrations` on every existing DB; removing it doesn't undo the applied SQL, and renaming it changes the hash so drizzle will try to re-apply the renamed file on the next run.
- **Never run raw SQL against the DB to "fix" a schema drift.** If schema and DB diverge, the right path is a corrective migration via `npx drizzle-kit generate --custom --name <reason>` (which scaffolds an empty SQL file plus matching journal/snapshot entries), then write the corrective DDL into that file. Make corrective DDL idempotent (`IF NOT EXISTS`, conditional `DROP NOT NULL`) so it survives partially-patched environments.
- **`db:generate` will silently miss a dropped migration if the snapshot already matches `schema.ts`.** Drizzle-kit diffs `schema.ts` against the latest snapshot, not against the live DB. If a previous merge dropped DDL but kept the snapshot, generate reports "no changes." When debugging schema drift, always inspect the DB directly (`\d <table>`) and compare against `schema.ts`, not against the snapshot.
- **`migrate.ts` always prints `[migrate] all migrations applied.` at the end.** That message is unconditional — it does **not** mean new migrations ran. To verify, query `drizzle.__drizzle_migrations` and compare row count against journal entry count, then spot-check actual columns with `\d`.
- **The `__drizzle_migrations` ledger is authoritative for "what drizzle thinks ran"; the live schema is authoritative for "what actually exists."** When they disagree, the ledger is the one that's wrong (inherited from a snapshot/dump or a bad merge). Fix it with a corrective migration — never `DELETE FROM __drizzle_migrations` to "force a rerun" without first verifying which DDL was already partially applied (you'll likely re-run statements that crash on already-existing tables/columns).
- **If you need to add a column / change a constraint, never just edit `schema.ts` and ship.** Always run `drizzle-kit generate` and confirm the produced SQL file actually contains the DDL you expect. A common failure mode is generating, then later resolving a merge conflict that empties the SQL file while leaving the snapshot — the schema looks correct in code review but no DDL ever runs.
- **If anything in `drizzle/` looks structurally weird** (duplicate number prefixes, gaps in the sequence, `idx` ordering not matching tag order), stop and surface it to the user before continuing. Do not attempt to "clean it up" silently — the journal hashes are what every existing DB matches against, and rewriting them retroactively breaks every other developer's local DB and every deployed environment.

### Logging (pino)
- `import { createLogger } from '<rel>/helpers/observability/logger'`. `const log = createLogger('scope')`.
- Signature: `log.level(metadataObj, "message")` — metadata is **first** arg.
- Levels: `debug` (cache hit/miss, retries), `info` (lifecycle/step), `warn` (recoverable failures), `error` (exceptions).
- **Structured first, message second.** Don't interpolate variables into the message.
- Standard fields: `step`, `requestId`, `reqId`, `userId`, `err`, `durationMs`, `status`, `attempt`, `choice`, `mode`, `hash`.
- Multi-stage step convention: `step ∈ {'started','submitted','succeeded','failed'}` with correlation id.
- `try/catch` always: `log.error({ err }, "context")` before reply.
- **Never log**: `privyToken`, `initData`, `serializedBlob`, `privyDid`, signatures, raw PII. Truncate via `token.slice(0,8)+'…'`.
- `console.*` banned in `src/` except `db/migrate.ts`. `LOG_PRETTY=true` is dev-only (devDep `pino-pretty` not in prod image — don't enable in container).

## Patterns
- **New system tool** (free, in-memory): `ITool` under `output/tools/system/` → add to `SystemToolProviderConcrete.getTools()`.
- **New developer HTTP tool**: `POST /http-tools`; loaded at runtime in `registryFactory`; AES-encrypted headers.
- **New tool (other)**: add `TOOL_TYPE` → implement `ITool` → register in `registryFactory`.
- **New DB table**: `schema.ts` → repo interface under `interface/output/repository/` → Drizzle impl under `output/sqlDB/repositories/` → add to `DrizzleSqlDB` → wire DI → `npm run db:generate && npm run db:migrate`.
- **New solver**: `ISolver` in `output/solver/static/` or via `manifestSolver/` → register under correct `INTENT_ACTION`.
- **New HTTP route**: add to `exactRoutes` or `paramRoutes`. Signature `(req, res, url, ...params) => Promise<void>`. `await this.extractUserId(req)` for authed routes.
- **New resolver field**: extend `RESOLVER_FIELD` → handler in `resolver/resolverEngine.ts` → reference from manifest's `requiredFields`.
- **New intent slash command**: extend `INTENT_COMMAND` → `parseIntentCommand` picks up automatically → map via `command_tool_mappings`.
- **New Capability**: implement `Capability`, register via `AssistantInject.getCapabilityDispatcher()` (`registry.register(...)`). Capabilities return `Artifact`s; renderer handles output. Don't call `bot.api.sendMessage` from a capability. Intermediate updates via `ctx.emit(artifact)`. Reserve unique `triggers.callbackPrefix` (registry throws on collision). Multi-command: use `triggers.commands?: INTENT_COMMAND[]`. Pending state must be JSON-safe (Redis adapter is drop-in).
- **Swap wallet provider**: new `IWalletDataProvider` impl → one DI line.

---

# Feature Log

## Healthcheck endpoint — 2026-04-25
`POST /health` (unauth) on `HttpApiServer`. Returns: `status`, `service`, `version` (`SERVICE_VERSION` or `"unknown"`), `processRole`, `nodeEnv`, `runtime`, `chain` (id/name/nativeSymbol via `CHAIN_CONFIG`), `uptimeSeconds`, `startedAtEpoch`, `timestampEpoch`, `memoryMb`, `services` (boolean map showing which 17 optional deps are wired). **Never** includes RPC URLs, addresses, env values, METRICS_TOKEN, user data, queue depths.

## Dockerfile — esbuild single-bundle — 2026-04-25
Debian-slim + esbuild bundle (`dist/server.js`) + tiny runtime `node_modules` (externals only). `entrypoint.ts` dispatches `migrate` then `worker|http|telegram` CLI per `PROCESS_ROLE`. Builder needs `python3 make g++` (gramJS → `websocket` → `utf-8-validate` runs node-gyp).

**Externals (must NOT bundle):** `pino`, `thread-stream`, `sonic-boom`, `pino-std-serializers` (worker_threads + dynamic transport require), `bufferutil`, `utf-8-validate`, `pg-native`, `pg-cloudflare`. Add to externals list AND runtime-modules copy loop when introducing any dep with: dynamic `require(variable)`, own `__dirname` reads, `.node` binary.

**Conventions:** `entrypoint.ts` is THE prod entry. `migrate.ts`/`workerCli.ts`/`httpCli.ts`/`telegramCli.ts` remain valid `tsx` dev targets. `esbuild` pinned inline in builder. Sourcemaps on; `NODE_OPTIONS=--enable-source-maps`. Cloud Run `PORT` → `HTTP_API_PORT` mapped in `entrypoint.ts`.

**When bumping pino** (or any hand-copied runtime dep): check `node_modules/pino/package.json` deps; update copy list. Bundling externals hides breakage until container start. Recently added: `@pinojs/redact` (replaces `fast-redact`), `bufferutil`, `utf-8-validate`, `node-gyp-build`.

## Loyalty Program (Season 0) — 2026-04-25
- **Schema**: `loyalty_seasons`, `loyalty_action_types`, `loyalty_points_ledger` + `users.loyalty_status`. Migration `0020_flippant_living_mummy.sql` seeds 7 action types + Season 0 (`globalMultiplier:3.0`, active) inline via `INSERT … ON CONFLICT DO NOTHING`. No separate seed script.
- **Formula** (`pointsFormula.ts:computePointsV1`): `base × volFactor × actionMult × globalMult × userMult`, capped at `perActionCap`, floored at 1, returns `0n` (skip insert) below `actionMinUsd`. `SeasonConfig` Zod-validated at repo boundary.
- **Ports** (hexagonal): `interface/input/loyalty.interface.ts` (`ILoyaltyUseCase`), `interface/output/repository/loyalty.repo.ts`.
- **Use case** `LoyaltyUseCaseImpl`: forbidden/flagged short-circuits; idempotency on `intent_execution_id` via pre-check + PG `23505` catch (returns existing entry, metric outcome `duplicate`); active-season Redis cache 60s; daily user cap (`gte` for midnight inclusion); leaderboard cache 30s **keyed by `seasonId:limit`**.
- **Repo** `DrizzleLoyaltyRepo`: hangs off `db.loyaltyRepo`; `SUM(points_raw)` for balance; rank via subquery; `findByIntentExecutionId` for idempotency.
- **HTTP**: `/loyalty/balance`, `/loyalty/history` (`nextCursor = entries.length === limit ? last.createdAtEpoch : null`), `/loyalty/leaderboard` (defaults `seasonId` to `getActiveSeasonId()`; `{ seasonId:null, entries:[] }` when no active season).
- **Telegram**: `LoyaltyCapability` (`/points`, `/leaderboard`). Anonymised (rank + truncated id + points; no full userId/wallet). `triggers.commands[]` plural. Time via `newCurrentUTCEpoch()` (`<60s` → "just now"). Markdown bold/italic instead of `padEnd`/`padStart`.
- **Award integrations** (always fire-and-forget — `void useCase?.awardPoints(...).catch(()=>undefined)`; use-case's own try/catch logs+metric, never throws):
  - `SwapCapability`: after `signingRequestUseCase.waitFor` resolves; emits `swap_same_chain` or `swap_cross_chain`. **`usdValue:undefined`** (Relay quote not surfaced) → flat-base v1.
  - `SendCapability`: `send_erc20` on `requestExecution` submission (only `/send`). **Awards on submit, not confirm** (no post-confirm hook).
  - `YieldCapability`: `yield_deposit` after `finalizeDeposit` (`usdValue ≈ amountRaw / 10^decimals`).
  - `yield_hold_day`: **not wired** (needs daily worker pass; deferred).
- **Metrics**: `metricsRegistry.recordLoyaltyAward(action, outcome, points?, durationMs?)`. Outcomes: `awarded`, `duplicate`, `forbidden`, `no_season`, `inactive_action`, `below_min_usd`, `daily_cap`, `error`. Exposed under `snapshot().loyalty`.
- **Tests**: 16 formula + 13 use-case in `tests/loyalty.*.test.ts`. Repo integration deferred.

**Conventions introduced:**
- `TriggerSpec.commands?: INTENT_COMMAND[]` for multi-command capabilities (`CapabilityRegistry.register()` indexes both `command` and `commands`).
- Loyalty awards always fire-and-forget at call site. Host transactions never depend on success.
- New action types: add row to `loyalty_action_types` AND label in `loyaltyCapability.ts` ACTION_LABELS AND FE `PointsTab.tsx`. Seven canonical: `swap_same_chain`, `swap_cross_chain`, `send_erc20`, `yield_deposit`, `yield_hold_day`, `referral`, `manual_adjust`.
- `LOYALTY_STATUSES` enum on `users` (separate from `status`): `normal`/`flagged` (suppress balance/leaderboard but still accrue) /`forbidden` (block awards). Reversible single UPDATE.
- `loyalty:*` Redis prefix mirrors `yield:*`.
- `getActiveSeasonId()` on `ILoyaltyUseCase` is canonical season resolver from outside the use-case — do **not** call `getBalance("")`.

**Plan deviations:**
1. Swap `usdValue:undefined` until Relay USD is plumbed through.
2. Send awards on submit; failed sends award 1pt — acceptable while send is lowest-weight.
3. `yield_hold_day` not awarded.
4. No HTTP write for `adjustPoints` (admin clawbacks); method exists but unreachable.

## Structured logging (pino) — 2026-04-24
Migrated all 127 `console.*` calls (29 files) to structured pino. Singleton `helpers/observability/logger.ts:createLogger`. Step-4 instrumented critical flows: `assistant.usecase` (history-loaded, llm-response, tool-result), `intent.usecase` (parse-start, intent-parsed, calldata-built, vector/ILIKE search), `signingRequest.usecase` (created/resolved/waitFor lifecycle), `capabilityDispatcher.usecase` (resolution choice matched/resumed/default, invoke, errors), all 4 `cache/redis.*` adapters (hit/miss debug), `yieldPoolRanker` (pool-ranked + low-liquidity/high-utilization disqualification), `yieldOptimizerUseCase` (user-nudged + idle-scan skip). Local services `LOG_LEVEL=debug LOG_PRETTY=true`.
**Why a helper, not a port/adapter:** logger is cross-cutting infra like `metricsRegistry` — DI through every constructor would add no abstraction value.

## Scaling — 2026-04-24
- DB pool `max:25` (env `DB_POOL_MAX`). Budget = replicas × POOL_MAX + 1 worker. 8 replicas × 25 = 200 → server `max_connections ≥ 250`.
- `IMessageDB.findByConversationId` accepts optional `limit`; assistant capped at `MESSAGE_HISTORY_LIMIT=30`.
- Global OpenAI concurrency cap (`openaiLimiter.ts`, `OPENAI_CONCURRENCY=6`) at all 5 call sites (orchestrator chat, embedding, intentParser, intentClassifier, schemaCompiler ×2).
- Datetime moved out of system prompt (`assistant.usecase`) into user-turn prefix → OpenAI prefix caching stays warm. Don't put time-varying content in `systemPrompt`.
- Privy `verifyTokenLite` LRU-cached (`sha256(token) → {privyDid}`, TTL 5min, max 5k). Revoked tokens valid in cache up to TTL — shorten / move to Redis if finer revocation needed.
- `IPendingCollectionStore` Redis-backed (`pending_collection:{channelId}`, TTL = `expiresAt`). DI picks Redis when `REDIS_URL` set. `PendingCollection.state` must be JSON-safe (no Date/BigInt/Buffer).
- Removed `sessionCache` map from `TelegramAssistantHandler`; session always read from Postgres (`telegram_sessions` indexed on chat_id). Multi-replica safe. Don't reintroduce in-process cache without solving cross-replica logout staleness.
- Split entrypoints (`workerCli` vs `httpCli`); `telegramCli` retained for combined dev. `PROCESS_ROLE` gates job startup. **Worker > 1 replica = duplicate Telegram notifications** — enforce max-instances=1.
- `/metrics` operator endpoint (bearer `METRICS_TOKEN`): pgPool saturation, openai p-limit queue depth, LLM p50/p95 + cache hit ratio, sampled Redis latency. `MetricsRegistry` singleton. `scripts/watch-metrics.sh` during load tests.
- Tavily (5min) + Relay quote (15s) cached in Redis (`redisResponseCache.ts`). Adapters skip when `REDIS_URL` unset. TTLs env-tunable.
- `ChainEntry.defaultRpcUrls` is `string[]` (primary → fallbacks). All viem PublicClients use `fallback([http(u1), http(u2), ...], { retryCount:1 })`. `RPC_URL_FALLBACKS` env supplements. `getChainRpcUrl` deprecated; prefer `getChainRpcUrls`.
- Production topology: `aegis-worker` (Cloud Run min=max=1) + `aegis-api` (min=2 max=8). Shared Upstash Redis + Neon Postgres. Single image, role via PROCESS_ROLE. Local parity: `docker compose --profile scale up`. **Don't raise worker > 1** without Redis-locked job singleton + grammy webhook-mode migration.
- **Removed legacy bot-signed autonomous execution path** (`ZerodevUserOpExecutor`, `IUserOpExecutor` port, `IIntentUseCase.confirmAndExecute`, `GET /intent/:intentId`, `ViemClientAdapter.walletClient`, `BOT_PRIVATE_KEY`). Backend never signs — all signing via user delegated session keys (mini-app + `ISigningRequestUseCase.create` + `waitFor`). New autonomous flows must reuse this pattern.

## GET /yield/positions — 2026-04-24
Privy-auth. Shape: `{ positions: PositionView[], totals: { principalHuman, currentValueHuman, pnlHuman } }`. PnL signed (+/-), 2 decimals; APY is fraction (FE × 100).

**Data sources** (read-only):
1. `yieldRepo.listActiveProtocols(userId)` — index of `(chainId,protocolId,tokenAddress)` tuples.
2. `adapter.getUserPosition(user, token)` — live on-chain (`aToken.balanceOf` for Aave v3).
3. `yieldRepo.getPrincipalRaw(...)` — cost basis for lifetime PnL.
4. `snapshots` row with `snapshotDateUtc===yesterday` for 24h delta (0 if user deposited <24h ago).
5. `adapter.getPoolStatus(token)` — live APY per position.

**Why no materialised `yield_positions` table:** balances drift every block (interest accrual). A snapshot would always be stale.
- `IYieldOptimizerUseCase.getPositions(userId)` — endpoint handler is a thin wrapper.
- `PROTOCOL_DISPLAY_NAMES: Record<YIELD_PROTOCOL_ID,string>` map in `yieldOptimizerUseCase.ts` — add a line per new protocol; no inline strings.
- **Totals decimals:** uses last-seen stablecoin's decimals (correct for single-USDC today). Per-symbol grouping or USD-normalisation needed when multi-stablecoin ships.

## /yield + /withdraw — proactive USDC optimizer — 2026-04-24
Avalanche mainnet, Aave v3.

- **3 DB tables** (`yield_deposits`, `yield_withdrawals`, `yield_position_snapshots`) — migration `0018_ordinary_toxin.sql`.
- **4 ports** under `use-cases/interface/yield/`: `IYieldProtocolAdapter`, `IYieldProtocolRegistry`, `IYieldPoolRanker`, `IYieldRepository`, `IYieldOptimizerUseCase`.
- **Aave v3 adapter** (`output/yield/aaveV3Adapter.ts`): `getPoolStatus` (ray→APY from `PoolDataProvider.getReserveData`), `buildDepositTx` (approve+supply), `buildWithdrawAllTx` (`maxUint256`), `getUserPosition` (`aToken.balanceOf`).
- **Ranking**: `score = 0.7·EMA_7d(supplyApy) + 0.3·currentSupplyApy`; disqualify if `liquidityUSD < $100k`; ×0.5 if utilization > 95%. `rank()` takes `tokenDecimals` (chain-agnostic).
- **3 jobs**: `YieldPoolScanJob` (2h), `UserIdleScanJob` (24h, sends nudge keyboard), `YieldReportJob` (5-min tick, fires once/day at `YIELD_REPORT_UTC_HOUR`).
- **`YieldCapability`**: `/yield`, `/withdraw`, `yield:opt:*` / `yield:custom` / `yield:skip` callbacks. Deposit/withdraw reuses `ISigningRequestUseCase.create` + `waitFor`.
- **`YieldOptimizerUseCase`**: `runPoolScan`, `scanIdleForUser`, `buildDepositPlan`, `finalizeDeposit`, `buildWithdrawAllPlan`, `buildDailyReport`. `WithdrawPlan.withdrawals[].balanceRaw` piped through; `finalizeWithdrawal` records actual withdrawn amount → `principalRaw = deposits − withdrawals` correct.
- **`listActiveUserIds()`** added to `ITelegramSessionDB`.
- `INTENT_COMMAND.YIELD`/`WITHDRAW` added; excluded from `SendCapability` routing.
- `YIELD_ENV` parsed once at module load.
- Avalanche mainnet config in `chainConfig.ts`: USDC `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`, Aave pool `0x794a61358D6845594F94dc1DB02A252b5b4814aD`, data provider `0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654`.
- `SignRequest.{kind,chainId,protocolId,tokenAddress,displayMeta}` (only on step 1) so FE `YieldDepositHandler` renders.
- `buildNudgeKeyboard()` exported from capability — reused in DI auto-nudge.

**Conventions**: yield adapters under `output/yield/`; jobs follow `start/stop + immediate-run + setInterval` (mirrors `TokenCrawlerJob`); chunk-based concurrency (`Promise.allSettled` chunks of N) when `p-limit` unavailable; chain/address config only in `chainConfig.ts` (`getYieldConfig`/`getEnabledYieldChains`); `YIELD_ENV` is the only `process.env` reader.

**Deferred (v2):** auto-rebalance (+ auto-exit on APY drop > threshold), partial withdrawal, multi-stablecoin, multi-chain idle scan, additional adapters (Benqi/Yearn), LLM-based adapter dispatch (only one protocol today), per-user timezone reports, tests (§12 of plan).

## /swap (Relay) — 2026-04-24
- `SwapCapability` registered for `INTENT_COMMAND.SWAP`. `collect()` reuses `intentUseCase.compileSchema` + `ResolverEngine` (`fromTokenSymbol`, `toTokenSymbol`, `readableAmount`, optional `from/toChainSymbol`); disambig via `buildDisambiguationPrompt` from `send.messages.ts`.
- `run()` runs **shared `aegisGuardInterceptor.checkTokenDelegation`** on origin token (extracted from SendCapability for de-dup). Insufficient → `ApproveRequest` artifact; user re-runs `/swap` after approving.
- Calls `RelaySwapTool.execute(...)` (hits `${RELAY_API_URL}/quote`); ordered tx list. Per step: `ISigningRequestUseCase.create` → `mini_app` artifact → `waitFor(requestId, timeoutMs)` (polls `sign_req:{id}`). Rejection/timeout short-circuits.
- **No `/confirm` gate** post-Aegis-Guard. Mini-app session key signs everything.
- Chain coverage: `chainConfig.ts` adds `relayEnabled:boolean` + exports `RELAY_SUPPORTED_CHAIN_IDS` + `resolveChainSymbol(sym?)`. Mainnets enabled; Fuji disabled.

**FE continuation:** `GET /request/:id?after=<prevId>` returns next pending `SignRequest`, backed by `user_pending_signs:<userId>` ZSET maintained by `RedisMiniAppRequestCache.store/delete`. Path `:id` ignored when `?after=` present.

**Conventions:**
- Aegis Guard re-approval lives only in `aegisGuardInterceptor.ts`. New autonomous flows must call it, not inline.
- `IRelayClient` port at `interface/output/relay.interface.ts`. `RelayClient` is a thin `fetch` wrapper.
- System tools may opt out of `SystemToolProviderConcrete` when command-path-only — `RelaySwapTool` registered solely via DI factory `getRelaySwapTool()`; LLM sees `execute_intent`, not `relay_swap`.
- `SwapCapability` constructs `ToolManifest` in-memory (no DB seed). Manifest consumed only by compile+resolver; Relay supplies calldata, so `buildRequestBody`/solver-registry are bypassed. Don't "fix" by seeding `tool_manifests`.
- `ISigningRequestUseCase` exposes `create()` + `waitFor(requestId, timeoutMs)`. New multi-step flows must use this pair, not fire-and-forget artifacts.
- Any cache implementing `IMiniAppRequestCache` must index `SignRequest` by `userId` so continuation lookup is O(log n).
- `RELAY_API_URL` env (default `https://api.relay.link`).

**Out of scope (v1):** slippage control (Relay default), destination-fill polling for cross-chain (Relay's `/intents/status/v2`).

## Capability refactor — 2026-04-23 (phase 1) → 2026-04-23 (phase 2 complete)
All Telegram flows go through `ICapabilityDispatcher`. Legacy branching in `handler.ts` is gone.

**In place:**
- Ports: `interface/input/capability.interface.ts` (`Capability`, `Artifact` discriminated union, `CollectResult`, `TriggerSpec`, `CapabilityCtx` with `emit`), `capabilityDispatcher.interface.ts`. Output: `capabilityRegistry`, `paramCollector`, `artifactRenderer`, `pendingCollectionStore` interfaces.
- `CapabilityRegistry`: in-memory index by id/command/callbackPrefix; throws on prefix collision. `match()` returns **only** explicit matches (never default — dispatcher owns "pending beats default").
- `CapabilityDispatcher`: priority (1) fresh slash/callback match (pre-empts and clears stale pending); (2) resume active pending-collection; (3) default free-text capability. Typing `/send` cancels unfinished `/buy`; bare reply "8" to disambig resumes pending instead of being swallowed by LLM.
- `pendingCollectionStore/inMemory.ts` + `redis.ts`. Capability state JSON-serialisable so Redis adapter is drop-in.
- `artifactRenderer/telegram.ts`: exhaustive switch subsuming `sendMiniAppPrompt`/`sendMiniAppButton` patterns.
- Capabilities: `BuyCapability`, `SendCapability` (one class, N instances per `INTENT_COMMAND` except `/buy` — full compile→resolve→disambig→buildRequestBody→delegation-check→sign + @handle resolution via MTProto+Privy + Aegis Guard re-approval), `SwapCapability`, `YieldCapability`, `LoyaltyCapability`, `AssistantChatCapability` (default; per-channel conversation id map).
- `send.messages.ts` / `send.utils.ts` relocated to output side (adapters never cross input↔output).

**Telegram handler** post-phase-2: ~200 LOC (from 1146). Auth gate + dispatcher forwarder. Removed: `orchestratorSessions`, `conversations`, `pendingRecipientNotifications`; `startCommandSession`, `startLegacySession`, `continueCompileLoop`, `runResolutionPhase`, `handleDisambiguationReply`, `buildAndShowConfirmation*`, `runDelegationCheck`, `tryCreateDelegationRequest`, `resolveRecipientHandle`, `handleFallbackChat`, `sendMiniAppButton`, `sendApproveButton`, `sendMiniAppPrompt`. Constructor 4 args (was 17). `handler.types.ts` deleted.

**Tests** (`be/tests/`): 22 black-box tests — dispatcher contract, registry matching, pending-store TTL, BuyCapability paths, SendCapability happy/abort/missing-question/disambiguation. Run `npx tsx --test tests/*.test.ts`.

## Onramp /buy — 2026-04-23
`/buy <amount>` does **NOT** go through `intentUseCase.selectTool`/`compileSchema`/manifests — it has no on-chain calldata, so `ToolManifestSchema` (requires `steps.min(1)`) wouldn't fit.

`BuyCapability` flow: parse via regex; bare `/buy` → ask amount; inline keyboard `buy:y:<amount>` / `buy:n:<amount>` (state on callback payload, no session); `buy:y` → shows SCA address + "Copy address" → `buy:copy:<addr>` re-sends bare mono address; `buy:n` → emits `OnrampRequest` mini-app.

**`OnrampRequest`** in `interface/output/cache/miniAppRequest.types.ts`: `{ requestType:'onramp', userId, amount, asset, chainId, walletAddress, ... }`. `RequestType` extended with `'onramp'`. Cache layer is polymorphic.

**Conventions:** slash command may bypass `selectTool` when no on-chain side effect (don't "fix" with a manifest); callback-payload-driven continuations preferred over in-memory follow-ups when state fits in 64 bytes; SCA is the deposit target.

**Out of scope:** deposit-watcher, MoonPay webhooks, non-USDC.

## Cleanup — 2026-04-23
**Removed** (see `constructions/cleanup-plan.md`):
- Unused use-case methods: `IAssistantUseCase.{listConversations,getConversation}`, `IIntentUseCase.{getHistory,parseFromHistory,previewCalldata}`, `ISolverRegistry.buildFromManifest`, `IIntentDB.listByUserId`.
- Unused repo methods: `IMessageDB.{findUncompressedByConversationId,markCompressed,findAfterEpoch}`, `IConversationDB.{update,findById,findByUserId,delete,upsertSummary,updateIntent,flagForCompression}`, `ITelegramSessionDB.deleteExpired`, `ITokenDelegationDB.findByUserIdAndToken`.
- Stale columns: `messages.compressed_at_epoch`, `conversations.{summary,intent,flagged_for_compression}`.
- Orphan files: `output/solver/restful/traderJoe.solver.ts`, `output/intentParser/openai.executionEstimator.ts`, `output/intentParser/intent.validator.ts` (relocated), empty `interface/output/sse/` dir.
- Dead env: `_jwtSecret?:string` on `HttpApiServer`, `process.env.JWT_SECRET`.

**Conventions enforced:**
- `newUuid()` for HTTP reqId (was `Math.random()`).
- `newCurrentUTCEpoch()` everywhere (was inline `Math.floor(Date.now()/1000)`).
- `process.env.*` hoisted to top-of-file consts in all parsers/handlers.
- `CAIP2_BY_PRIVY_NETWORK` map moved into `chainConfig.ts`, derived from `CHAIN_REGISTRY` (each entry carries `privyNetwork`).
- `getTelegramNotifier()` cached singleton; `getAuthUseCase` reuses.
- Hexagonal restored: `validateIntent` moved to `use-cases/implementations/`; `WINDOW_SIZE` to `interface/input/intent.errors.ts`. `MiniAppRequest`/`MiniAppResponse` moved to `interface/output/cache/miniAppRequest.types.ts`.

**Duplicates collapsed:** three Telegram button senders → single `sendMiniAppPrompt`; resolver from/to-token logic → `resolveTokenField(slot, symbol, chainId)`.

**Flow simplifications:** `httpServer.handle()` from 24-branch chain → dispatch map. `handleApproveMiniAppResponse` subtype branches → `applySessionKeyApproval` / `applyAegisGuardApproval`.

**Deferred:** flattening `continueCompileLoop` / `handleDisambiguationReply` — higher blast radius.

## Portfolio resilience — 2026-04-23
`PortfolioUseCaseImpl.getPortfolio` was serial `for`-loop awaiting `getNativeBalance`/`getErc20Balance` — single RPC failure 500'd. Mirrored `GetPortfolioTool` pattern: per-token `.catch(() => 0n)` + `Promise.all`. Shape unchanged.

## Gas sponsorship — 2026-04-23
`ZerodevUserOpExecutor` accepts optional `paymasterUrl`; when present builds `createZeroDevPaymasterClient` + wires `{ getPaymasterData, getPaymasterStubData }` into `createKernelAccountClient`. URL on `CHAIN_CONFIG.paymasterUrl` (read from `AVAX_PAYMASTER_URL`). `bundlerUrl` also hoisted onto `CHAIN_CONFIG` for symmetry. `installSessionKey` still uses `toSudoPolicy({})` — before enabling sponsorship in prod, tighten to `toCallPolicy` + ZeroDev gas caps, otherwise compromised session blob drains paymaster budget.

## First-time mobile login 401 — 2026-04-24
`POST /response` with `requestType=auth` was gated by `resolveUserId` (returns null when no user row exists yet) — blocked the flow that creates the user. Re-ordered `handlePostResponse`: auth requests call `loginWithPrivy` directly, take returned `userId`. Sign/approve keep the resolveUserId+ownership gate. Unswallowed Privy verify error in `AuthUseCaseImpl.resolveUserId`.
**Convention:** endpoints that can create a user (only `POST /response` `requestType=auth` today) must NOT call `resolveUserId` as a gate. They verify token via `loginWithPrivy`/`verifyToken` and use returned `userId`. Every other endpoint keeps `resolveUserId` and 401s on null.

## Cloud Run deployment + GitHub Actions CI/CD — 2026-04-25
Project `aegis-494004`, region `us-east1`. Auto-deploy on push to `main`.

**Topology:**
| Service | Role | Public | Scaling | Notes |
|---|---|---|---|---|
| `aegis-http` | `http` | yes | 0–3, conc=80 | Assistant HTTP API. Scales to zero. |
| `aegis-worker` | `worker` | no (IAM) | pinned 1, no CPU throttling | grammy long-poll + cron jobs (`tokenCrawler`, `yieldPoolScan`, `userIdleScan`, `yieldReport`) + signing-callback HTTP. |

Single image `us-east1-docker.pkg.dev/aegis-494004/aegis/aegis-backend:<sha>`. Both listen on `8080`. Both run drizzle migrations on boot via `entrypoint.ts → migrate.ts`.

**Why pin worker = 1 + no CPU throttling:** owns long-lived state (gramJS MTProto socket, grammy long-poll) and timer-driven crons. Throttling would freeze timers; multi-instance would duplicate Telegram polling and double-fire crons.

**External storage (free tier, all `us-east-1`):** Postgres via Neon (pooled, scales to zero); Redis via Upstash (`rediss://`, TLS).

**Secrets** (Google Secret Manager, mounted via `--set-secrets KEY=KEY:latest`): `DATABASE_URL`, `REDIS_URL`, `OPENAI_API_KEY`, `PINECONE_*`, `TELEGRAM_BOT_TOKEN`, `TG_API_*`, `TG_SESSION`, `PRIVY_*`, `TAVILY_API_KEY`, `HTTP_TOOL_HEADER_ENCRYPTION_KEY`, `METRICS_TOKEN`, `AVAX_BUNDLER_URL`, `AVAX_PAYMASTER_URL`, `REWARD_CONTROLLER_ADDRESS`, `MINI_APP_URL`. Cloud Run only re-reads on revision creation — bump secrets then redeploy.

**CI/CD** — GitHub Actions + Workload Identity Federation (no JSON SA key). Pool `github-pool`, provider scoped by `attribute.repository_owner == 'rye-ndt'`. SA `aegis-deployer@aegis-494004.iam.gserviceaccount.com` with `run.admin`, `artifactregistry.writer`, `iam.serviceAccountUser`, `secretmanager.secretAccessor`. Workflow `.github/workflows/deploy.yml`: on push to `main`, build job pushes image with `${GITHUB_SHA}`, matrix deploy job updates both services in parallel.

**Repo variables** (not secrets): `GCP_PROJECT`, `WIF_PROVIDER`, `SERVICE_ACCOUNT`.

**Migration fix:** seeding `int4` "no end" / infinity = `2147483647` (year-2038 sentinel — re-issue Season N before then). Was `9999999999` which overflows `int4`, rolled back the whole batch, left empty schema.

**Observability:**
```bash
gcloud run services describe aegis-http   --region=us-east1 --project=aegis-494004 --format='value(status.conditions[0].type,status.conditions[0].status)'
gcloud run services describe aegis-worker --region=us-east1 --project=aegis-494004 --format='value(status.conditions[0].type,status.conditions[0].status)'
gcloud logging read 'resource.type="cloud_run_revision" AND severity>=ERROR' --project=aegis-494004 --limit=10 --freshness=30m
gcloud beta run services logs tail aegis-worker --region=us-east1 --project=aegis-494004
```
End-to-end smoke: send any message to the Telegram bot.

**Cost (~$15–20/mo):** worker always-on ~$13–18; http ~$0–2; AR <$1; Neon/Upstash/SecretMgr free.

**Follow-ups:** update `MINI_APP_URL` from ngrok before shipping; if `worker.exposedPort` ever needs external callers, change to `--allow-unauthenticated` or front via `aegis-http`; if load grows, split crons → Cloud Run **Jobs** triggered by Cloud Scheduler.

## Feature log

### Endpoint auth hardening — 2026-04-25
- `POST /tools`, `POST /command-mappings`, `DELETE /command-mappings/:command` — require admin (Privy token resolved to `privyDid` checked against `ADMIN_PRIVY_DIDS` env var).
- `GET /permissions?public_key=` — require Privy; 403 if caller's `smartAccountAddress` ≠ queried `public_key`.
- `GET /request/:requestId` (no `?after=`) — `auth`-type requests remain public (bootstrap); all other types (`sign`, `approve`, `onramp`) require Privy + ownership (`request.userId === caller`).
- Approach: `requireAdmin(req, res)` helper injected with `IUserDB` (new optional constructor param on `HttpApiServer`). No schema change, no new ports.

## Backlog
- Proactive agent: daily market sentiment → investment verdict.
- Temporarily disable RAG (speed/correctness); re-enable as tool count grows.
- Aegis Guard agent-side enforcement: pre-UserOp re-check `limitRaw - spentRaw` + `validUntil`; call `incrementSpent` after confirmed execution.
- OpenAI-backed execution estimator only if deterministic insufficient (was removed during cleanup).
