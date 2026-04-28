# Aegis Backend — Status

## What it is
Non-custodial, intent-based AI trading agent on Avalanche (and beyond). Hexagonal Architecture (Ports & Adapters) — use-cases depend only on interfaces; assembly lives in `src/adapters/inject/assistant.di.ts`. Users auth via Privy (Google or Telegram); Mini App passes `telegramChatId` to `POST /auth/privy`. Agent parses NL (incl. `$5` fiat shortcuts), classifies intent, compiles tool input schema, resolves fields, and executes via ERC-4337 UserOps through ZeroDev session keys. **Backend never signs transactions** — all signing via user delegated session keys in the mini-app.

## Tech stack
| Layer | Choice |
|---|---|
| Language | TypeScript 5.3, Node.js, strict |
| Interface | Telegram (`grammy`) + HTTP API (native `node:http`) |
| ORM | Drizzle ORM + PostgreSQL (`pg`) |
| LLM | OpenAI (`gpt-4o` / configurable) |
| Blockchain | `viem` ^2 — any EVM chain, ERC-4337 |
| Account Abs | ZeroDev SDK + `permissionless` ^0.2 |
| Validation | Zod 4.3.6 |
| Cache | Redis via `ioredis` |
| Telegram | `grammy` + `telegram` (gramjs / MTProto) |
| Auth | Privy (`@privy-io/server-auth`) — no backend JWTs |
| Cross-chain | Relay (`RELAY_API_URL`) |
| Yield | Aave v3 (Avalanche mainnet) |
| Portfolio | Ankr (`ankr_getAccountBalance`) + RPC fallback |
| Deployment | Cloud Run + Neon Postgres + Upstash Redis + GitHub Actions (WIF) |

## Non-negotiable rules
1. **Hexagonal architecture.** Use-case layer imports only `use-cases/interface/`. No adapter-to-adapter cross-imports. Assembly only in `assistant.di.ts`.
2. **No inline config literals.** Every `process.env.X` hoisted to top-of-file `const`. Chain-specific values in `chainConfig.ts`.
3. **No raw SQL.** Schema changes via `schema.ts` + `npm run db:generate && npm run db:migrate`.
4. **Privy-token-only auth.** `authUseCase.resolveUserId(token)` — never issue or accept a backend JWT.
5. **Time is seconds.** Always `newCurrentUTCEpoch()`. IDs always `newUuid()` (v4).
6. **New features = new Capabilities.** Do not add flow logic to `handler.ts`.
7. **Backend never signs transactions.** `BOT_PRIVATE_KEY` / `IUserOpExecutor` was removed 2026-04-24 — do not reintroduce.
8. **Loyalty awards are fire-and-forget.** Host transactions must never depend on points succeeding.
9. **`POST /response` auth requests bypass `resolveUserId`.** Any endpoint that can create a user must verify via `loginWithPrivy` directly, not `resolveUserId`.

## Project structure
```
src/
├── entrypoint.ts                  # Prod entry — migrate, dispatch by PROCESS_ROLE
├── telegramCli.ts                 # Dev: HTTP + Telegram + jobs
├── workerCli.ts                   # PROCESS_ROLE=worker — bot + jobs
├── httpCli.ts                     # PROCESS_ROLE=http — HTTP only
├── use-cases/
│   ├── implementations/           # assistant, auth, capabilityDispatcher, capabilityRegistry,
│   │                              # commandMapping, httpQueryTool, intent, loyalty, portfolio,
│   │                              # recipientNotification, sessionDelegation, signingRequest,
│   │                              # tokenIngestion, toolRegistration, validateIntent,
│   │                              # aegisGuardInterceptor, yieldOptimizer, yieldPoolRanker
│   └── interface/
│       ├── input/                 # IAssistantUseCase, IAuthUseCase, ICapability,
│       │                          # ICapabilityDispatcher, ICommandMappingUseCase,
│       │                          # IHttpQueryToolUseCase, IIntentUseCase, ILoyaltyUseCase,
│       │                          # IPortfolioUseCase, ISessionDelegationUseCase,
│       │                          # ISigningRequestUseCase, ITokenIngestionUseCase,
│       │                          # IToolRegistrationUseCase, IYieldOptimizerUseCase
│       └── output/
│           ├── blockchain/        # IChainReader, IBalanceProvider
│           ├── cache/             # IMiniAppRequestCache, ISessionDelegationCache,
│           │                      # ISigningRequestCache, IUserProfileCache
│           ├── delegation/        # IDelegationRequestBuilder
│           ├── repository/        # 17 repos: users, telegramSessions, conversations,
│           │                      # messages, userProfiles, tokenRegistry, intents,
│           │                      # intentExecutions, toolManifests, pendingDelegations,
│           │                      # feeRecords, commandToolMappings, httpQueryTools,
│           │                      # userPreferences, tokenDelegations, loyalty,
│           │                      # recipientNotification
│           ├── yield/             # IYieldProtocolAdapter, IYieldProtocolRegistry,
│           │                      # IYieldPoolRanker, IYieldRepository,
│           │                      # IPrincipalProvider, IYieldPositionDiscovery
│           └── [other ports]      # solver, embedding, intentParser, orchestrator,
│                                  # resolver, schemaCompiler, toolIndex, vectorDB, etc.
├── adapters/
│   ├── inject/assistant.di.ts     # Lazy-singleton wiring
│   └── implementations/
│       ├── input/
│       │   ├── http/httpServer.ts # exactRoutes + paramRoutes
│       │   ├── jobs/              # tokenCrawlerJob, yieldPoolScanJob,
│       │   │                      # userIdleScanJob, yieldReportJob
│       │   └── telegram/          # bot.ts, handler.ts (~200 LOC)
│       └── output/
│           ├── balance/           # ankrBalanceProvider, rpcBalanceProvider,
│           │                      # cachedBalanceProvider (30s TTL decorator)
│           ├── capabilities/      # buyCapability, sendCapability, swapCapability,
│           │                      # yieldCapability, loyaltyCapability,
│           │                      # assistantChatCapability
│           ├── yield/             # aaveV3Adapter, subgraphPrincipalProvider,
│           │                      # onChainPositionDiscovery
│           ├── solver/            # solverRegistry, claimRewards.solver,
│           │                      # manifestDriven.solver
│           └── [other adapters]   # openai, viemClient, resolverEngine,
│                                  # pinecone, redis caches, relay, etc.
└── helpers/
    ├── chainConfig.ts             # CHAIN_REGISTRY, CHAIN_CONFIG, all chain-specific values
    ├── notifyResolved.ts          # Shared sign-resolution Telegram notification
    ├── decodeErc20Transfer.ts     # transfer(address,uint256) calldata decoder
    ├── observability/             # logger.ts (pino), metricsRegistry.ts
    ├── enums/                     # All enums (executionStatus, intentAction, intentCommand, etc.)
    ├── crypto/aes.ts              # AES-256-GCM (iv:authTag:ciphertext)
    └── [other helpers]            # bigint, uuid, cache, concurrency, env, errors, loyalty, time
```

## Contract Registry
Default chain: Avalanche C-Chain mainnet (43114). `CHAIN_ID=43113` → Fuji.
- AegisToken (Proxy, Fuji): `0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69`
- RewardController (Proxy, Fuji): `0x519092C2185E4209B43d3ea40cC34D39978073A7`
- Reward-controller address per-deploy via `REWARD_CONTROLLER_ADDRESS` env.

## HTTP API
Port `HTTP_API_PORT` (default 4000). CORS allows all origins. Reqid = `newUuid().slice(0,8)`.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/health` | None | Deployment metadata (status, service, version, processRole, runtime, chain, uptime, memoryMb, services map). No secrets. |
| `POST` | `/auth/privy` | None | Verify token; upsert user + link Telegram session |
| `GET` | `/user/profile` | Privy | Cached user profile |
| `GET` | `/portfolio` | Privy | On-chain SCA balances (Ankr or RPC) |
| `GET` | `/yield/positions` | Privy | Live positions + totals (on-chain probe via `OnChainPositionDiscovery`) |
| `GET` | `/loyalty/balance` | Privy | `{ seasonId, pointsTotal:string, rank }` |
| `GET` | `/loyalty/history?limit=&cursorCreatedAtEpoch=` | Privy | `{ entries[], nextCursor }` |
| `GET` | `/loyalty/leaderboard?limit=&seasonId=` | None | Defaults to `getActiveSeasonId()` |
| `GET` | `/tokens?chainId=` | None | Verified tokens |
| `POST/DELETE /:toolId` | `/tools` | Admin | Register/deactivate dynamic tool manifests |
| `GET` | `/tools` | None | List dynamic tool manifests |
| `GET` | `/permissions?public_key=` | Privy + ownership | Session-key delegations by address |
| `GET/POST /:id/signed` | `/delegation/pending` | Privy | ZeroDev message lifecycle |
| `GET` | `/request/:requestId` | `auth`=None; others=Privy+ownership | Mini-app polls work items |
| `GET` | `/request/:requestId?after=<id>` | Privy | Next queued sign request (Redis ZSET) |
| `POST` | `/response` | mixed | Mini-app result; `auth` bypasses `resolveUserId` |
| `POST/DELETE /:command` | `/command-mappings` | Admin | Set/delete command → toolId |
| `GET` | `/command-mappings` | None | List mappings |
| `POST/GET/DELETE /:id` | `/http-tools` | Privy | HTTP query tools (AES-256-GCM headers) |
| `GET/POST` | `/preference` | Privy | `aegisGuardEnabled` |
| `GET` | `/delegation/approval-params` | Privy | Default tokens + suggested limits |
| `GET/POST` | `/delegation/grant` | Privy | List/upsert `token_delegations` |
| `GET` | `/metrics` | Bearer (`METRICS_TOKEN`) | pgPool/openai/redis/LLM metrics |

## Telegram commands
| Command | Behavior |
|---|---|
| `/start`, `/auth`, `/logout`, `/new`, `/history`, `/confirm`, `/cancel`, `/portfolio`, `/wallet`, `/sign` | Auth + meta |
| `/buy <amount>` | BuyCapability — onramp keyboard (copy SCA address or MoonPay mini-app) |
| `/send`, `/money`, `/convert`, `/topup`, `/dca`, `/sell` | SendCapability — compile→resolve→Aegis Guard→sign |
| `/swap` | SwapCapability — Relay cross/same-chain |
| `/yield`, `/withdraw` | YieldCapability — Aave v3 deposit/withdraw |
| `/points`, `/leaderboard` | LoyaltyCapability |
| _(text)_ | AssistantChatCapability — chat + tool-call loop |
| _(photo)_ | Vision chat with caption |

## Intent / message flow
```
message
  ├─ slash command   → CapabilityDispatcher
  │     priority: fresh match → resume pending → default free-text
  └─ free text       → classifyIntent → toolIndex lookup → schemaCompiler
                             ↓
                       ResolverEngine (token symbols, amounts, @handle via MTProto+Privy)
                             ↓
                       DeterministicExecutionEstimator (preview)
                             ↓
                       Capability → ISigningRequestUseCase.create → mini_app artifact
                       Mini-app polls /request/:id → signs → POST /response → waitFor resumes
```

## Database schema
| Table | Purpose |
|---|---|
| `users` | `privyDid`, `status`, `email`, `loyalty_status` |
| `telegram_sessions` | chatId → userId + expiry |
| `conversations` | Per-user threads |
| `messages` | All turns (user/assistant/tool/assistant_tool_call) |
| `user_profiles` | SCA, EOA, session key, scope, status, telegramChatId |
| `token_registry` | symbol → addr+decimals per chainId |
| `intents`, `intent_executions` | Lifecycle + per-attempt records (userOpHash, txHash, fees) |
| `tool_manifests` | toolId, steps (JSON), inputSchema, chainIds, priority |
| `pending_delegations` | Queued ZeroDev messages awaiting signature |
| `fee_records` | Protocol fee audit trail |
| `command_tool_mappings` | bare word → toolId |
| `http_query_tools` + `http_query_tool_headers` | Developer HTTP tools (AES-encrypted headers) |
| `user_preferences` | `aegisGuardEnabled` |
| `token_delegations` | `limitRaw`, `spentRaw`, `validUntil` per token |
| `yield_position_snapshots` | Yield positions (snapshots only — deposits/withdrawals dropped 2026-04-28) |
| `loyalty_seasons`, `loyalty_action_types`, `loyalty_points_ledger` | Loyalty program |
| `recipient_notifications` | P2P send recipient notifications (pending/delivered/failed) |

## Redis key schema
| Key | TTL | Value |
|---|---|---|
| `delegation:{sessionKeyAddress}` | none | `DelegationRecord` |
| `sign_req:{id}` | `max(10s, expiresAt-now)` | signing request |
| `mini_app_req:{requestId}` | 600s | `MiniAppRequest` |
| `user_pending_signs:<userId>` (ZSET) | maintained | per-user pending sign index |
| `user_profile:{userId}` | min 10s | `PrivyUserProfile` |
| `pending_collection:{channelId}` | `min(expiresAt-now, 1h)` | `PendingCollection` |
| `tavily:{sha1(...)}` | `TAVILY_CACHE_TTL_SECONDS` (300s) | search response |
| `relay_quote:{sha1(...)}` | `RELAY_QUOTE_CACHE_TTL_SECONDS` (15s) | RelayQuote |
| `yield:best:{chainId}:{token}` | 3h | `{protocolId,score,apy,ts}` |
| `yield:apy_series:{chainId}:{protocolId}:{token}` | none | list (84 samples) |
| `yield:nudge_cooldown:{userId}` | `YIELD_NUDGE_COOLDOWN_SEC` | `"1"` |
| `yield:nudge_pending:{userId}` | `YIELD_NUDGE_COOLDOWN_SEC` | `"1"` |
| `yield:report_done:{YYYY-MM-DD}` | 25h | `"1"` |
| `loyalty:season:active` | 60s | active season JSON |
| `loyalty:leaderboard:{seasonId}:{limit}` | 30s | leaderboard JSON |

## Key environment variables
| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost/aether_intent` | Postgres |
| `REDIS_URL` | — | Redis (optional; adapters fall back to in-memory) |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | — / `gpt-4o` | LLM + embeddings |
| `OPENAI_CONCURRENCY` | `6` | Per-replica p-limit cap |
| `TELEGRAM_BOT_TOKEN`, `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` | — | Telegram + MTProto |
| `HTTP_API_PORT` | `4000` | (Cloud Run `PORT` remapped in `entrypoint.ts`) |
| `MINI_APP_URL` | — | Mini-app base URL |
| `CHAIN_ID` | `43114` | Resolved against `CHAIN_REGISTRY` |
| `RPC_URL`, `RPC_URL_FALLBACKS` | from CHAIN_CONFIG | Primary + comma-separated fallbacks |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | — | Privy |
| `PRIVY_VERIFY_CACHE_TTL_MS`, `PRIVY_VERIFY_CACHE_MAX` | `300000` / `5000` | LRU verifyTokenLite |
| `ANKR_API_KEY` | — | Optional; absent → public endpoint (rate-limited, warns at startup) |
| `PORTFOLIO_PROVIDER` | `ankr` | `ankr` \| `rpc` |
| `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `PINECONE_HOST` | — | Tool index |
| `TAVILY_API_KEY`, `TAVILY_CACHE_TTL_SECONDS` | — / `300` | Web search |
| `RELAY_API_URL`, `RELAY_QUOTE_CACHE_TTL_SECONDS` | `https://api.relay.link` / `15` | Cross-chain swap |
| `THEGRAPH_API_KEY` | — | Messari Aave V3 subgraph (deployment `72Cez54APnySAn6h8MswzYkwaL9KjvuuKnKArnPJ8yxb`). Absent → PnL shows 0. |
| `REWARD_CONTROLLER_ADDRESS` | — | `ClaimRewardsSolver` target |
| `HTTP_TOOL_HEADER_ENCRYPTION_KEY` | — | 32-byte hex AES-256-GCM |
| `MAX_TOOL_ROUNDS`, `MESSAGE_HISTORY_LIMIT` | `10` / `30` | Assistant guardrails |
| `PROCESS_ROLE` | `combined` | `worker` \| `http` \| `combined` |
| `DB_POOL_MAX` | `25` | Postgres pool (budget: replicas × 25 + 1 ≤ max_connections) |
| `METRICS_TOKEN` | — | `/metrics` bearer (unset = disabled) |
| `ADMIN_PRIVY_DIDS` | — | Comma-sep DIDs for admin routes. Unset = 403. |
| `LOG_LEVEL`, `LOG_PRETTY` | `info` (prod) | pino config |
| `YIELD_IDLE_USDC_THRESHOLD_USD` | `10` | Min idle USDC to nudge |
| `YIELD_POOL_SCAN_INTERVAL_MS` | `1800000` | Pool scan cadence |
| `YIELD_USER_SCAN_INTERVAL_MS` | `1800000` | Idle user scan cadence |
| `YIELD_REPORT_UTC_HOUR` | `9` | Daily report UTC hour |
| `YIELD_NUDGE_COOLDOWN_SEC` | `1800` | Cooldown between nudges |
| `YIELD_ENABLED_CHAIN_IDS` | `43114` | Comma-separated |
| `LOYALTY_ACTIVE_SEASON_CACHE_TTL_MS` | `60000` | |
| `LOYALTY_LEADERBOARD_CACHE_TTL_MS` | `30000` | |

## Coding conventions
- **IDs**: `newUuid()` only (UUID v4). **Timestamps**: `newCurrentUTCEpoch()` (seconds). Columns end in `AtEpoch`.
- **Config**: every `process.env.X` hoisted to top-of-file `const`. Chain values in `chainConfig.ts` only.
- **Enums**: prefer `helpers/enums/` values over inline strings. `parseIntentCommand` is the only slash matcher.
- **Hexagonal**: `MiniAppRequest`/`DelegationRecord` live under `interface/output/cache/` — no cross-layer leakage.
- **DB facade**: single `DrizzleSqlDB`; repos hang off as `db.users`, `db.toolManifests`, etc. Use-cases receive the repo interface, never the facade.
- **Lazy singletons** in `AssistantInject`: `if (!this._x) this._x = new X(...)`. Optional-env services return `undefined` when unconfigured.
- **HTTP routing**: `exactRoutes` or `paramRoutes` only. Never if/else chains.
- **Encrypted secrets**: `helpers/crypto/aes.ts` (iv:authTag:ciphertext hex).
- **Logging**: pino via `createLogger('ScopeName')`. Metadata is first arg. Never `console.*` in `src/`. Never log tokens, privyDid, signatures, raw PII.

## Extension patterns
- **New system tool**: `ITool` → add to `SystemToolProviderConcrete.getTools()`.
- **New DB table**: `schema.ts` → repo interface → Drizzle impl → `DrizzleSqlDB` → DI → `db:generate && db:migrate`.
- **New solver**: `ISolver` in `output/solver/` → register under correct `INTENT_ACTION`.
- **New HTTP route**: `exactRoutes` or `paramRoutes`. Signature: `(req, res, url, ...params) => Promise<void>`.
- **New Capability**: implement `Capability`, register in `AssistantInject.getCapabilityDispatcher()`. Reserve unique `triggers.callbackPrefix`.
- **New sign-error code**: add to FE `interpretSignError.ts` AND BE `notifyResolved.ts` recovery branch. String is the contract.
- **New chain**: one `CHAIN_REGISTRY` entry in `chainConfig.ts`; set `ankrBlockchain` if Ankr supports it.

---

## Drizzle migrations — handle with extreme care

The `drizzle/` folder is merge-hostile. The `_journal.json`, per-migration `meta/*_snapshot.json` files, and sequential `NNNN_*.sql` filenames all collide across branches. This repo has dual `0016_*.sql` files, a missing `0019_*`, and at least one merge silently dropped an `ALTER TABLE users ADD COLUMN privy_did` statement — login broke in production.

**Rules:**
- **Always rebase onto main before `drizzle-kit generate`.** Never hand-resolve conflicts in `drizzle/` — abort, drop local migrations, rebase, regenerate.
- **Never delete or rename a migration that landed on main.** Its hash is in `__drizzle_migrations` on every DB.
- **Never fix schema drift with raw SQL.** Use `npx drizzle-kit generate --custom --name <reason>` and write idempotent DDL into the scaffolded file.
- **`migrate.ts` always prints "all migrations applied" — that's unconditional.** Verify with `SELECT * FROM drizzle.__drizzle_migrations` and `\d <table>`.
- **Schema drift check:** drizzle diffs `schema.ts` against latest snapshot, not the live DB. Inspect the DB directly when debugging drift.
- If anything in `drizzle/` looks structurally weird (duplicate prefixes, gaps, wrong `idx` order), stop and surface it before continuing.

---

## Production topology (Cloud Run, `us-east1`)

| Service | Role | Public | Scaling |
|---|---|---|---|
| `aegis-http` | `http` | yes | 0–3, concurrency=80 |
| `aegis-worker` | `worker` | no (IAM) | pinned 1, no CPU throttle |

Single image `us-east1-docker.pkg.dev/aegis-494004/aegis/aegis-backend:<sha>`. Both run migrations on boot. Worker pinned at 1 (owns gramJS MTProto socket + cron timers — CPU throttle freezes timers; >1 replica duplicates polling). External: Neon Postgres + Upstash Redis (both `us-east-1`). Secrets via Google Secret Manager. CI/CD: GitHub Actions + WIF, no JSON SA keys.

---

## Feature log

### P2P Send recipient notifications — 2026-04-28
`RecipientNotificationUseCase` + `IRecipientNotificationRepo` + `recipient_notifications` table. When a `/send` completes, `dispatchP2PSend` looks up the recipient's Telegram chatId; if they're onboarded, delivers immediately; otherwise queues the notification for later. `flushPendingForTelegramUser` is called on next `/start` (or auth) to drain the queue. Single notification renders with explorer link; digest (>1) renders a bullet list without links.

### Ankr-backed portfolio — 2026-04-28
Replaced per-token RPC loop with swappable `IBalanceProvider` port. `AnkrBalanceProvider` (single HTTP call, non-zero balances + USD values) wrapped in `CachedBalanceProvider` (30s in-memory TTL). `RpcBalanceProvider` is the fallback. Feature-flagged via `PORTFOLIO_PROVIDER=ankr|rpc` (default `ankr`). `ANKR_API_KEY` optional (absent → public endpoint, warns at startup). Fuji (43113) has no `ankrBlockchain` and always uses RPC.

### Yield positions revamp — 2026-04-28
- Active-protocol discovery replaced: was DB-only; now **on-chain probe** via `OnChainPositionDiscovery` (fans out across every `protocol × stablecoin` pair in chain config). Positions opened outside Aegis are now visible.
- Principal source replaced: was deposit/withdrawal bookkeeping; now **The Graph Messari Aave V3 subgraph** (`SubgraphPrincipalProvider`). Falls back to `balanceRaw` (zero PnL) when subgraph returns null.
- `yield_deposits` + `yield_withdrawals` tables **dropped** (`0026_stale_mandrill.sql`).
- `buildDepositPlan` no longer writes a DB row. `finalizeDeposit(userId, txHash)` — writes snapshot via `positionDiscovery.discover + principalProvider`.
- `finalizeWithdrawal` is a no-op (on-chain read reflects new state on next poll).
- `yieldReportJob` user enumeration: `listUsersWithRecentSnapshots(sinceEpoch)` (30-day window, from `yield_position_snapshots`).
- New ports: `IPrincipalProvider`, `IYieldPositionDiscovery`. New adapters: `subgraphPrincipalProvider`, `onChainPositionDiscovery`.
- Avalanche USDC aToken: `0x625E7708f30cA75bfd92586e17077590C60eb4cD`. Subgraph deployment: `72Cez54APnySAn6h8MswzYkwaL9KjvuuKnKArnPJ8yxb`.

### Sign-resolution UX — 2026-04-27
`helpers/notifyResolved.ts` shared across all CLIs. Decodes ERC-20 transfer calldata (`helpers/decodeErc20Transfer.ts`). On success: sends explorer link via `getExplorerTxUrl(chainId, txHash)` from chainConfig. On `insufficient_token_balance` + USDC: sends `buy:y/<amount>` / `buy:n/<amount>` inline keyboard (re-enters BuyCapability confirm step). Non-USDC or decode failure → plain message.

### Loyalty Program (Season 0) — 2026-04-25
Formula (`computePointsV1`): `base × volFactor × actionMult × globalMult × userMult`, capped + floored. Idempotent on `intent_execution_id` (pre-check + PG `23505` catch). Fire-and-forget at all call sites. Seven canonical action types: `swap_same_chain`, `swap_cross_chain`, `send_erc20`, `yield_deposit`, `yield_hold_day`, `referral`, `manual_adjust`. `yield_hold_day` not yet wired (deferred). Season seeded via `0020_flippant_living_mummy.sql` `INSERT … ON CONFLICT DO NOTHING`. Leaderboard cache keyed `seasonId:limit`. `LOYALTY_STATUSES` on `users`: `normal/flagged/forbidden`.

### Cloud Run CI/CD — 2026-04-25
GCP project `aegis-494004`, region `us-east1`. Auto-deploy on `main`. WIF pool `github-pool`, SA `aegis-deployer`. Matrix deploy of `aegis-http` + `aegis-worker` in parallel. `int4` loyalty seasons: `validUntil` sentinel is `2147483647` (year-2038 — `9999999999` overflows `int4`, crashed migration).

### Healthcheck endpoint — 2026-04-25
`POST /health` (unauth). Returns: status, service, version, processRole, nodeEnv, runtime, chain (id/name/nativeSymbol), uptimeSeconds, memoryMb, services (17-key boolean map). Never exposes addresses, env values, METRICS_TOKEN, or queue depths.

### Endpoint auth hardening — 2026-04-25
Admin gate (`ADMIN_PRIVY_DIDS`) on `POST /tools`, `POST/DELETE /command-mappings`. Ownership gate on `GET /permissions`, `GET /request/:id` (non-auth types). `POST /response` auth type bypasses `resolveUserId` — calls `loginWithPrivy` directly (bootstrap path).

### Scaling — 2026-04-24
DB pool `max:25`. `MESSAGE_HISTORY_LIMIT=30`. OpenAI global concurrency cap (`openaiLimiter.ts`, `OPENAI_CONCURRENCY=6`). DateTime moved out of system prompt → OpenAI prefix caching stays warm. Privy `verifyTokenLite` LRU-cached (SHA256 key, 5min TTL, 5k max). `IPendingCollectionStore` Redis-backed. Multi-replica safe session reads (Postgres, not in-process map). Tavily (5min) + Relay quote (15s) cached in Redis. `ChainEntry.defaultRpcUrls` is `string[]` — viem uses `fallback([...], { retryCount:1 })`.

### Capability refactor — 2026-04-23
All Telegram flows go through `ICapabilityDispatcher`. `handler.ts` trimmed to ~200 LOC (was 1146). `TriggerSpec.commands[]` for multi-command capabilities. Pending state must be JSON-safe (Redis adapter is drop-in). `artifactRenderer/telegram.ts` exhaustive switch over `Artifact` union.

### Swap (Relay) — 2026-04-24
`SwapCapability` for `/swap`. Aegis Guard check → `RelaySwapTool.execute` → per-step `SigningRequest`. `?after=<prevId>` continuation for multi-step flows (backed by `user_pending_signs:<userId>` ZSET). `SwapCapability` constructs `ToolManifest` in-memory (no DB seed).

### Yield optimizer — 2026-04-24
Avalanche mainnet, Aave v3. `runPoolScan` / `scanIdleForUser` / `buildDepositPlan` / `finalizeDeposit` / `buildWithdrawAllPlan` / `buildDailyReport`. Ranking: `score = 0.7·EMA_7d(supplyApy) + 0.3·currentSupplyApy`; disqualify if liquidity < $100k; ×0.5 if utilization > 95%. `INTENT_COMMAND.YIELD/WITHDRAW` excluded from SendCapability routing.

### Onramp /buy — 2026-04-23
`BuyCapability` bypasses `selectTool`/manifests (no on-chain calldata). Inline keyboard `buy:y/<amount>` / `buy:n/<amount>` — state in callback payload (no session). `buy:y` → shows SCA address + copy button; `buy:n` → `OnrampRequest` mini-app.

### Structured logging — 2026-04-24
All `console.*` migrated to pino. Singleton `helpers/observability/logger.ts:createLogger`. Critical flows instrumented: assistant, intent, signingRequest, capabilityDispatcher, all redis caches, yieldPoolRanker, yieldOptimizerUseCase.

## Backlog
- Proactive daily market sentiment → investment verdict agent.
- Aegis Guard agent-side enforcement: pre-UserOp re-check `limitRaw - spentRaw + validUntil`; `incrementSpent` after confirmed execution.
- `yield_hold_day` daily award (needs worker pass).
- Admin HTTP endpoint for `adjustPoints` (clawbacks).
- Cross-chain swap: destination-fill polling (`Relay /intents/status/v2`).
- Multi-stablecoin yield, partial withdrawal, additional yield adapters (Benqi/Yearn).
- Flush pending recipient notifications on `/start` for non-onboarded recipients.
