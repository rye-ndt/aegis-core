# Aegis Backend — Status

## What it is
Non-custodial, intent-based AI trading agent on Avalanche (and beyond). Hexagonal Architecture (Ports & Adapters) — use-cases depend only on interfaces; assembly lives in `src/adapters/inject/assistant.di.ts`. Users auth via Privy (Google or Telegram); Mini App passes `telegramChatId` to `POST /auth/privy`. Agent parses NL (incl. `$5` fiat shortcuts), classifies intent, compiles tool input schema, resolves fields, and executes via ERC-4337 UserOps through ZeroDev session keys. **Backend never signs transactions** — all signing via user delegated session keys in the mini-app.

> Capability-level details and recent feature notes live in `src/adapters/implementations/output/capabilities/status.md`. Read that file alongside this one before changing capability code. Aster (tokenized stocks) adapter notes live in `src/adapters/implementations/output/aster/status.md` — read before touching the Aster Diamond ABI, pair registry, or broker provider.

## Tech stack
| Layer | Choice |
|---|---|
| Language | TypeScript 5.3, Node.js, strict |
| Interface | Telegram (`grammy`) + HTTP API (native `node:http`) |
| ORM | Drizzle ORM + PostgreSQL (`pg`) |
| LLM | OpenAI (`gpt-4o` / configurable) |
| Blockchain | `viem` ^2 — any EVM chain, ERC-4337 |
| Account Abs | ZeroDev SDK (Kernel v3.1, EntryPoint 0.7) + `permissionless` ^0.2 — we **derive** SCAs ourselves via `helpers/aaConfig.ts` + `helpers/deriveScaAddress.ts` |
| Validation | Zod 4.3.6 |
| Cache | Redis via `ioredis` |
| Telegram | `grammy` + `telegram` (gramjs / MTProto) |
| Auth | Privy (`@privy-io/server-auth`) — no backend JWTs |
| Cross-chain | Relay (`RELAY_API_URL`) |
| Yield | Aave v3 (Avalanche mainnet) |
| Portfolio | Ankr (`ankr_getAccountBalance`) + RPC fallback |
| Transfers | Ankr (`ankr_getTransactionsByAddress` + `ankr_getTokenTransfers`) merged + cached |
| Stocks | Aster perpetuals on BSC (Diamond `0x1b6F…feb0`), 1× leverage, USDC.bsc (18-dec) collateral, Relay-bridged from home chain |
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
10. **AA stack constants live exclusively in `helpers/aaConfig.ts`.** Never inline `entryPoint`, `kernelVersion`, or `index`. The two `aaConfig.ts` files (FE + BE) MUST stay in lockstep — drift silently changes a user's SCA.
11. **`eoa_address` is canonicalized to lowercase on write.** Lookups by EOA must lowercase the search term.
12. **Native pseudo-address is `0xEeee…EEeE`.** Always compare via `isNativeAddress(addr)` (case-insensitive). Never insert native rows into `tokenRegistry` — they are synthesized from chain config.

## Project structure
```
src/
├── entrypoint.ts                          # Prod entry — migrate, dispatch by PROCESS_ROLE
├── {telegram,worker,http}Cli.ts           # Dev / worker / http entrypoints
├── use-cases/
│   ├── implementations/                   # one file per use-case (assistant, auth, capabilityDispatcher,
│   │                                      # commandMapping, httpQueryTool, intent, loyalty, portfolio,
│   │                                      # recipientNotification, sessionDelegation, signingRequest,
│   │                                      # tokenIngestion, toolRegistration, transferHistory,
│   │                                      # validateIntent, aegisGuardInterceptor, yieldOptimizer,
│   │                                      # yieldPoolRanker, capabilityRegistry)
│   └── interface/{input,output}/          # ports — output subdirs: blockchain (IChainReader,
│                                          # IBalanceProvider, ITransferHistoryProvider), cache,
│                                          # delegation, repository (17 repos), yield (6 sub-ports),
│                                          # solver, embedding, intentParser, orchestrator, resolver,
│                                          # schemaCompiler, toolIndex, vectorDB, etc.
├── adapters/
│   ├── inject/assistant.di.ts             # Lazy-singleton wiring
│   └── implementations/
│       ├── input/
│       │   ├── http/httpServer.ts         # exactRoutes + paramRoutes
│       │   ├── jobs/                      # tokenCrawler, yieldPoolScan, userIdleScan, yieldReport
│       │   └── telegram/                  # bot.ts, handler.ts (~200 LOC)
│       └── output/                        # balance (ankr/rpc/cached 30s), transferHistory
│                                          # (ankr/cached rate-guarded), capabilities (buy/send/swap/
│                                          # yield/loyalty/assistantChat/stock/positions),
│                                          # yield (aaveV3Adapter, subgraphPrincipalProvider,
│                                          # onChainPositionDiscovery), aster (Diamond client +
│                                          # ABI + pair registry + price oracle + positions +
│                                          # broker provider), stocks (relayCrossChainSwapPlanner),
│                                          # tools (system + read-only agent tools incl. getStockQuote
│                                          # / getStockPositions), solver, openai, viemClient,
│                                          # resolverEngine, pinecone, redis caches, relay, etc.
└── helpers/
    ├── chainConfig.ts                     # CHAIN_REGISTRY/CONFIG; getViemChain, getRpcUrlForChain,
    │                                      # getNativeTokenInfo, NATIVE_PSEUDO_ADDRESS, isNativeAddress
    ├── aaConfig.ts                        # AA stack constants — lockstep with FE
    ├── deriveScaAddress.ts                # Counterfactual SCA derivation (1h LRU)
    ├── notifyResolved.ts                  # Shared sign-resolution Telegram notification
    ├── decodeErc20Transfer.ts             # transfer(address,uint256) calldata decoder
    ├── observability/                     # logger.ts (pino), metricsRegistry.ts
    ├── enums/                             # All enums (executionStatus, intentAction, intentCommand, …)
    ├── crypto/aes.ts                      # AES-256-GCM (iv:authTag:ciphertext)
    ├── env/                               # Per-feature env readers (e.g. transferHistoryEnv)
    ├── errors/                            # RateLimitedError, UnsupportedChainError
    └── …                                  # bigint, uuid, cache, concurrency, time, loyalty
```

## Contract Registry
Default chain: Avalanche C-Chain mainnet (43114). `CHAIN_ID=43113` → Fuji.
- AegisToken (Proxy, Fuji): `0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69`
- RewardController (Proxy, Fuji): `0x519092C2185E4209B43d3ea40cC34D39978073A7`
- Reward-controller address per-deploy via `REWARD_CONTROLLER_ADDRESS` env.
- Avalanche USDC aToken: `0x625E7708f30cA75bfd92586e17077590C60eb4cD`.
- Aave V3 subgraph (Messari): deployment `72Cez54APnySAn6h8MswzYkwaL9KjvuuKnKArnPJ8yxb`.
- Aster Diamond (BSC, perpetuals entrypoint): `0x1b6F2d3844C6ae7D56ceb3C3643b9060ba28FEb0`. Per-facet implementations resolved through the Diamond — refresh `asterAbi.ts` from BscScan if struct decode breaks.
- USDC.bsc (Aster venue collateral, **18 decimals**): `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`. Decimals always sourced from `token_registry`, never hardcoded.

## HTTP API
Port `HTTP_API_PORT` (default 4000). CORS allows all origins. Reqid = `newUuid().slice(0,8)`.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/health` | None | Deployment metadata (status, service, version, processRole, runtime, chain, uptime, memoryMb, services map). No secrets. |
| `POST` | `/auth/privy` | None | Verify token; upsert user + link Telegram session |
| `GET` | `/user/profile` | Privy | Cached user profile |
| `GET` | `/portfolio` | Privy | On-chain SCA balances (Ankr or RPC) |
| `GET` | `/transfers?direction=&limit=&cursor=&fromEpoch=&toEpoch=` | Privy | Ankr-backed transfer history. 429 → `RateLimitedError` (with `Retry-After`); 400 → `UnsupportedChainError`. `Cache-Control: private, max-age=30`. |
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
| `GET` | `/delegation/approval-params` | Privy | Default tokens + suggested limits (synthesizes native via `getNativeTokenInfo`) |
| `GET/POST` | `/delegation/grant` | Privy | List/upsert `token_delegations` |
| `GET` | `/metrics` | Bearer (`METRICS_TOKEN`) | pgPool/openai/redis/LLM metrics |
| `GET` | `/stocks/pairs` | None | Verified Aster stock pairs (`{ symbol, pairBase }[]`). 503 `stocks_unavailable` if boot verification failed. `Cache-Control: public, max-age=3600`. |
| `GET` | `/stocks/quote?symbols=AAPL,TSLA` | None | Mark prices for tradable Aster pairs via cached oracle. 400 on unknown symbols. 503 `stocks_unavailable` when soft-disabled. `Cache-Control: private, max-age=10`. |
| `GET` | `/stocks/positions` | Privy | Authenticated SCA's open Aster positions via `IStockUseCase.listPositions`. 503 `stocks_unavailable` when soft-disabled. |
| `GET` | `/delegation/approval-params?chainId=56` | Privy | Optional `chainId` query param routes the suggested-tokens response to a specific chain. Omitted → home chain. USDC.bsc decimals (18) are sourced from `token_registry`. |

## Telegram commands
| Command | Behavior |
|---|---|
| `/start`, `/auth`, `/logout`, `/new`, `/history`, `/confirm`, `/cancel`, `/portfolio`, `/wallet`, `/sign` | Auth + meta |
| `/buy <amount>` | BuyCapability — onramp keyboard (copy SCA address or MoonPay mini-app) |
| `/send`, `/money`, `/convert`, `/topup`, `/dca`, `/sell` | SendCapability — compile→resolve→Aegis Guard→sign (native + ERC-20 both auto-sign) |
| `/swap` | SwapCapability — Relay cross/same-chain |
| `/yield`, `/withdraw` | YieldCapability — Aave v3 deposit/withdraw |
| `/points`, `/leaderboard` | LoyaltyCapability |
| `/stock buy $X SYM`, `/stock short $X SYM`, `/stock close SYM`, `/stock sl SYM PRICE`, `/stock tp SYM PRICE` | StockCapability — Aster perpetuals on BSC. Bridges USDC.avax→USDC.bsc, opens, awards loyalty. Recovery flow on venue revert is its own mini-app session. `close` disambiguates multi-position symbols via inline keyboard (`stock:close-pick:<tradeHashShort>`); `sl`/`tp` use the same picker (`stock:exits-pick:<short>:<sl\|tp>:<price>`) and preserve the unchanged side. After successful `close`, the venue→home return-swap is appended in the same mini-app session via `executeSignSteps({ continueSession: true, planKind: "recovery" })` — `notifyResolved` then surfaces "Funds returned." UX. |
| `/positions` | PositionsCapability — chat-seeded LLM summary of open Aster positions via the `get_stock_positions` tool. |
| _(text)_ | AssistantChatCapability — chat + tool-call loop |
| _(photo)_ | Vision chat with caption |

## Intent / message flow
```
message
  ├─ slash command   → CapabilityDispatcher
  │     priority: fresh match → resume pending → default free-text
  └─ free text       → classifyIntent → toolIndex lookup → schemaCompiler
                             ↓
                       ResolverEngine (token symbols, amounts, @handle via MTProto+Privy;
                                       handle path resolves to SCA via DB or
                                       deriveScaAddress when un-onboarded)
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
| `user_profiles` | SCA, EOA (lowercased), session key, scope, status, telegramChatId. Has `findByEoaAddress(eoa)`. |
| `token_registry` | symbol → addr+decimals per chainId. **Native tokens are synthesized**, not stored. |
| `intents`, `intent_executions` | Lifecycle + per-attempt records (userOpHash, txHash, fees) |
| `tool_manifests` | toolId, steps (JSON), inputSchema, chainIds, priority |
| `pending_delegations` | Queued ZeroDev messages awaiting signature |
| `fee_records` | Protocol fee audit trail |
| `command_tool_mappings` | bare word → toolId |
| `http_query_tools` + `http_query_tool_headers` | Developer HTTP tools (AES-encrypted headers) |
| `user_preferences` | `aegisGuardEnabled` |
| `token_delegations` | `limitRaw`, `spentRaw`, `validUntil` per token. Native is valid (`tokenAddress = NATIVE_PSEUDO_ADDRESS`). `upsertMany` preserves `spent_raw` when `limit_raw` is unchanged. |
| `yield_position_snapshots` | Yield positions (snapshots only — deposits/withdrawals dropped 2026-04-28) |
| `loyalty_seasons`, `loyalty_action_types`, `loyalty_points_ledger` | Loyalty program. `action_types` seed includes `stock_open_long`, `stock_open_short`, `stock_close` (added 2026-05-04 with Aster Phase 2). |
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
| `transfers:{userId}:{...}` + stale companion | `TRANSFER_HISTORY_PAGE_TTL_SEC` | transfer page (day-bucketed) |
| `transfers:user_window:{userId}` | rolling | per-user RPM counter |
| `transfers:global_bucket` | per-second | global token bucket |
| `yield:best:{chainId}:{token}` | 3h | `{protocolId,score,apy,ts}` |
| `yield:apy_series:{chainId}:{protocolId}:{token}` | none | list (84 samples) |
| `yield:nudge_cooldown:{userId}` | `YIELD_NUDGE_COOLDOWN_SEC` | `"1"` |
| `yield:nudge_pending:{userId}` | `YIELD_NUDGE_COOLDOWN_SEC` | `"1"` |
| `yield:report_done:{YYYY-MM-DD}` | 25h | `"1"` |
| `loyalty:season:active` | 60s | active season JSON |
| `loyalty:leaderboard:{seasonId}:{limit}` | 30s | leaderboard JSON |

## Key environment variables
| Variable(s) | Default | Purpose |
|---|---|---|
| `DATABASE_URL` / `DB_POOL_MAX` | `postgres://localhost/aether_intent` / `25` | Postgres. Pool budget: replicas × 25 + 1 ≤ max_connections |
| `REDIS_URL` | — | Redis (optional; adapters fall back to in-memory) |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_CONCURRENCY` | — / `gpt-4o` / `6` | LLM + embeddings; per-replica p-limit cap |
| `TELEGRAM_BOT_TOKEN`, `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` | — | Telegram + MTProto |
| `HTTP_API_PORT`, `MINI_APP_URL` | `4000` / — | (Cloud Run `PORT` remapped in `entrypoint.ts`) |
| `CHAIN_ID`, `RPC_URL`, `RPC_URL_FALLBACKS` | `43114` / from CHAIN_CONFIG | Resolved against `CHAIN_REGISTRY`; comma-separated fallbacks |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFY_CACHE_TTL_MS`, `PRIVY_VERIFY_CACHE_MAX` | — / `300000` / `5000` | Privy + LRU verifyTokenLite |
| `ANKR_API_KEY`, `PORTFOLIO_PROVIDER` | — / `ankr` (\|`rpc`) | Optional Ankr; absent → public endpoint (warns at startup). Shared by portfolio + transfer history. |
| `TRANSFER_HISTORY_RPM_USER`, `_RPS_GLOBAL`, `_PAGE_TTL_SEC`, `_PAGE_OLDER_TTL_SEC`, `_STALE_TTL_SEC` | — | `/transfers` rate guards + cache TTLs (fresh / older / stale companion) |
| `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `PINECONE_HOST` | — | Tool index |
| `TAVILY_API_KEY`, `TAVILY_CACHE_TTL_SECONDS` | — / `300` | Web search |
| `RELAY_API_URL`, `RELAY_QUOTE_CACHE_TTL_SECONDS` | `https://api.relay.link` / `15` | Cross-chain swap |
| `THEGRAPH_API_KEY` | — | Messari Aave V3 subgraph. Absent → PnL shows 0. |
| `REWARD_CONTROLLER_ADDRESS` | — | `ClaimRewardsSolver` target |
| `HTTP_TOOL_HEADER_ENCRYPTION_KEY` | — | 32-byte hex AES-256-GCM |
| `MAX_TOOL_ROUNDS`, `MESSAGE_HISTORY_LIMIT` | `10` / `30` | Assistant guardrails |
| `PROCESS_ROLE` | `combined` | `worker` \| `http` \| `combined` |
| `METRICS_TOKEN` | — | `/metrics` bearer (unset = disabled) |
| `ADMIN_PRIVY_DIDS` | — | Comma-sep DIDs for admin routes. Unset = 403. |
| `LOG_LEVEL`, `LOG_PRETTY` | `info` (prod) | pino config |
| `YIELD_IDLE_USDC_THRESHOLD_USD`, `YIELD_POOL_SCAN_INTERVAL_MS`, `YIELD_USER_SCAN_INTERVAL_MS`, `YIELD_NUDGE_COOLDOWN_SEC`, `YIELD_ENABLED_CHAIN_IDS` | `10` / `1800000` / `1800000` / `1800` / `43114` | Yield job cadences + nudge gating |
| `YIELD_REPORT_UTC_HOUR`, `YIELD_REPORT_INTERVAL_MS` | `9` / unset | Daily report UTC hour. When `INTERVAL_MS>0`, run at that interval and skip the daily gate (debug/QA). |
| `LOYALTY_ACTIVE_SEASON_CACHE_TTL_MS`, `LOYALTY_LEADERBOARD_CACHE_TTL_MS` | `60000` / `30000` | |
| `BSC_USDC` | `0x8AC76a…580d` (Binance-Peg USDC) | Venue collateral for Aster stocks. **18 decimals**, sourced from `token_registry`. Required for stocks. |
| `ASTER_DIAMOND_ADDRESS_BSC` | `0x1b6F2d…feb0` | Aster Diamond proxy on BSC. Address validated at boot via `verifyStockCapability()`. |
| `BSC_RPC_URL` | unset → chainConfig fallbacks (`bsc.publicnode.com` etc.) | Optional BSC RPC override. |
| `ASTER_BROKER_ID` | `0` | Aster broker referral id (uint). |
| `ASTER_PRICE_TTL_SEC`, `ASTER_POSITIONS_TTL_SEC` | `15` / `60` | In-memory cache TTLs for marks + positions. |
| `STOCK_RECOVERY_ENABLED` | `true` | When false, disables auto-bridge-back on venue-leg revert AND the post-close return swap. Leave `true` outside debugging. |

## Coding conventions
- **IDs**: `newUuid()` only (UUID v4). **Timestamps**: `newCurrentUTCEpoch()` (seconds). Columns end in `AtEpoch`.
- **Config**: every `process.env.X` hoisted to top-of-file `const`. Chain values in `chainConfig.ts` only.
- **Enums**: prefer `helpers/enums/` values over inline strings. `parseIntentCommand` is the only slash matcher.
- **Hexagonal**: `MiniAppRequest`/`DelegationRecord` live under `interface/output/cache/` — no cross-layer leakage.
- **DB facade**: single `DrizzleSqlDB`; repos hang off as `db.users`, `db.toolManifests`, etc. Use-cases receive the repo interface, never the facade.
- **Lazy singletons** in `AssistantInject`: `if (!this._x) this._x = new X(...)`. Optional-env services return `undefined` when unconfigured.
- **HTTP routing**: `exactRoutes` or `paramRoutes` only. Never if/else chains.
- **Encrypted secrets**: `helpers/crypto/aes.ts` (iv:authTag:ciphertext hex).
- **Logging**: pino via `createLogger('ScopeName')`. Metadata is first arg. Never `console.*` in `src/`. Never log tokens, privyDid, signatures, raw PII. Common metadata fields: `step`, `reqId`/`userId`, `err`, `durationMs`, `status`, `attempt`, `choice` (cache hit/miss), `count`, `source: "db"|"derived"`, `stale: boolean`.
- **Free-tier external providers**: wrap adapter in a `CachedXxxProvider(inner, cache, userId, cfg)` decorator using `acquireUserSlot(userId, rpm)` + `acquireGlobalSlot(rps)`. Never inline rate-limit logic into adapters. Use the generic `RateLimitedError` / `UnsupportedChainError` (HTTP layer maps to 429/400; tools surface graceful retry messages).
- **Spend bookkeeping**: capabilities emitting autosign signing-requests for ERC20 spends MUST set `tokenAddress` (lowercased) + `amountRaw` (decimal raw string) on the `SigningRequestRecord` / `sign_calldata` artifact of the **single tx that actually moves the user's funds** — typically the last step. Native paths leave both undefined. `signingRequest.usecase.resolveRequest` calls `tokenDelegationDB.addSpent(userId, tokenAddress, amountRaw)` best-effort.
- **Multi-step capabilities**: emit `mini_app` for step 1 only; store steps 2..N via `miniAppRequestCache.store(...)`; FE chains via `GET /request/:id?after=<prev>`. One mini-app session per intent.
- **Fiat normalization**: `OpenAISchemaCompiler.compile()` runs `normalizeFiatAmount(text)` before LLM — `$N`/`N dollars/bucks/usd` → `N USDC`. New capabilities inherit this; don't re-implement `detectStablecoinIntent`.
- **Recipient resolution**: `eoa → DB profile.smartAccountAddress` if onboarded, else `deriveScaAddress(eoa, chainId)`. DB row always wins over derivation.
- **Soft-fail capability boot**: capabilities that depend on external invariants (e.g. on-chain ABI struct verification) expose an `async verifyXCapability()` on `AssistantInject` that swallows errors and flips a `_xCapabilityDisabled` flag. CLIs `await` it after instantiation; the rest of the backend keeps booting. HTTP routes guard via `isXCapabilityDisabled()` and return `503 { error: "x_unavailable" }`. Pattern lives in `verifyStockCapability` — mirror it for any new chain-bound capability.
- **Per-step `chainId` on cross-chain plans**: `StockExecutionStep.chainId` is set per step so a single mini-app session can sequence home-chain bridge legs and venue-chain action legs together. The FE's chained `?after=<prevId>` poll picks each up with its own chainId. Mirror this on any future cross-chain capability.
- **`spendTokenAddress` only on the LAST home-chain leg** of multi-step cross-chain plans (mirrors `swapCapability`). Tagging a venue-chain leg attributes spend against a delegation row that doesn't exist for the venue-chain token.
- **Venue-chain id exception**: chain ids may NOT be inlined outside `chainConfig.ts` — except in a single venue adapter module that pins one venue (e.g. `asterBrokerProvider.ts:VENUE_CHAIN_ID = 56`). Document the constant and never reach for it elsewhere.

## Extension patterns
- **New system tool**: `ITool` → add to `SystemToolProviderConcrete.getTools()`.
- **New DB table**: `schema.ts` → repo interface → Drizzle impl → `DrizzleSqlDB` → DI → `db:generate && db:migrate`.
- **New solver**: `ISolver` in `output/solver/` → register under correct `INTENT_ACTION`.
- **New HTTP route**: `exactRoutes` or `paramRoutes`. Signature: `(req, res, url, ...params) => Promise<void>`.
- **New Capability**: implement `Capability`, register in `AssistantInject.getCapabilityDispatcher()`. Reserve unique `triggers.callbackPrefix`.
- **New sign-error code**: add to FE `interpretSignError.ts` AND BE `notifyResolved.ts` recovery branch. String is the contract.
- **New chain**: one `CHAIN_REGISTRY` entry in `chainConfig.ts`; set `ankrBlockchain` if Ankr supports it. Native token is auto-synthesized from viem's `Chain.nativeCurrency`.
- **New external provider port**: define `IXxxProvider` under `interface/output/blockchain` (or appropriate subdir). Implement `CachedXxxProvider` decorator with the rate-guard template.
- **New read-only agent tool**: implement `ITool` under `output/tools/`, add to `TOOL_TYPE` enum, register in `SystemToolProviderConcrete.getTools()` (gated on optional dep bundle). For stock-style soft-disabled tools, take an `isDisabled: () => boolean` and return `{ success: false, error: "<feature>_unavailable" }` when set. Read-only tools must never trigger autosign or mutations.
- **New venue-chain capability (e.g. another perp DEX)**: (a) add the chain to `CHAIN_REGISTRY` with `relayEnabled` initially false; (b) define `IXxxBrokerProvider` + companion ports under `interface/output/<feature>/`; (c) put the venue chain id constant only in the broker adapter; (d) add `verifyXCapability()` boot hook + soft-disable flag; (e) flip `relayEnabled: true` once the bridge round-trip is smoke-tested.

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
- **`int4` season `validUntil` sentinel is `2147483647`** (year-2038). `9999999999` overflows `int4` and crashed migration once.

---

## Production topology (Cloud Run, `us-east1`)

| Service | Role | Public | Scaling |
|---|---|---|---|
| `aegis-http` | `http` | yes | 0–3, concurrency=80 |
| `aegis-worker` | `worker` | no (IAM) | pinned 1, no CPU throttle |

Single image `us-east1-docker.pkg.dev/aegis-494004/aegis/aegis-backend:<sha>`. Both run migrations on boot. Worker pinned at 1 (owns gramJS MTProto socket + cron timers — CPU throttle freezes timers; >1 replica duplicates polling). External: Neon Postgres + Upstash Redis (both `us-east-1`). Secrets via Google Secret Manager. CI/CD: GitHub Actions + WIF, no JSON SA keys. Auto-deploy on `main`. WIF pool `github-pool`, SA `aegis-deployer`. Matrix deploy of `aegis-http` + `aegis-worker` in parallel.

---

## Feature log (condensed — see `output/capabilities/status.md` for full notes)

- **2026-05-04 — Aster tokenized stocks Phase 3 (close + SL/TP + /positions + return-swap).** `runClose` chains the venue→home return-swap into the same mini-app session via `executeSignSteps({ continueSession: true, planKind: "recovery" })` — `notifyResolved` then surfaces "Funds returned." on the resolved leg. Multi-position SL/TP picker (`stock:exits-pick:<short>:<sl|tp>:<price>`) mirrors the close-pick pattern. `/positions` ships as `PositionsCapability` (LLM-seeded, calls `get_stock_positions` system tool). PnL formatting reads `collateralToken.decimals` (was hardcoded 6 → 10^12 display bug on 18-dec USDC.bsc).
- **2026-05-04 — Aster tokenized stocks Phase 2 (open / short execution + agent tools + read routes).** `StockUseCaseImpl` (open / close / set-exits / return-swap / list / resolve) consumes `IStockBrokerProvider` + `ICrossChainSwapPlanner` + `IStockPriceOracle` + `IStockPairRegistry` + `IStockPositionsProvider`. `RelayCrossChainSwapPlanner` adapts `IRelayClient.getQuote` to the planner port (consumes `currencyOut.amount` as `expectedOutRaw`; defensively coerces hex `value` → decimal). `StockCapability` parses `/stock buy|short|close|sl|tp` deterministically (regex). 6 sign-error codes (`aster_pair_inactive`, `aster_min_size`, `aster_max_position`, `aster_oracle_stale`, `aster_insufficient_collateral`, `stock_recovery_failed`) — lockstep contract with FE `interpretSignError.ts`. `SigningRequestRecord.planKind: "recovery"` flows through `SigningResolutionEvent` → `notifyResolved` for recovery-success UX. BSC `relayEnabled: true` flipped on. Read-only agent tools `get_stock_quote` / `get_stock_positions` (NO execution tools — agent never trades directly). HTTP `GET /stocks/quote`, `GET /stocks/positions`. Three new loyalty action types (`stock_open_long/short/close`).
- **2026-05-04 — Aster tokenized stocks Phase 1 (read-only foundation).** BSC chain registry entry (relayEnabled initially false). `AsterDiamondClient` (single viem PublicClient pinned to BSC, fan-out via `fallback`). `AsterPairRegistry` — 6 hardcoded symbols (AAPL/AMZN/TSLA/NVDA/GOOG/META) verified against live `pairsV4()` at boot via `verifyStockCapability()`. Soft-fail boot: errors flip `_stockCapabilityDisabled` and flow as 503 `stocks_unavailable` from every stock route — backend keeps booting. New ports under `interface/output/stocks/` (`IStockBrokerProvider`, `IStockPriceOracle`, `IStockPairRegistry`, `IStockPositionsProvider`, `ICrossChainSwapPlanner`). `GET /stocks/pairs`, `npm run verify:aster` script. `divFixed` shared BigInt helper. Chain id `56` lives only in `asterBrokerProvider.ts:VENUE_CHAIN_ID` (documented exception).
- **2026-05-04 — Native token via synthesis.** `NATIVE_PSEUDO_ADDRESS` + `getNativeTokenInfo(chainId)` in `chainConfig.ts`; `DbTokenRegistryService` synthesizes the native row (no DB seed). `manifestSolver/stepExecutors.executeErc20Transfer` branches on `isNativeAddress` to emit `{ value: amountRaw, data: "0x" }`.
- **2026-05-04 — Native auto-sign.** Removed the `!fromToken.isNative` guard in `sendCapability`; native sends now share the autosign branch. `awardPoints` branches `send_native` vs `send_erc20`. `tryEmitDelegationRequest` still skips native (no on-chain `approve()`).
- **2026-05-04 — Ankr transfer history.** New `ITransferHistoryProvider` port; `AnkrTransferHistoryProvider` merges `getTransactionsByAddress` + `getTokenTransfers`. `CachedTransferHistoryProvider` adds Redis cache + per-user RPM + global RPS + stale-on-gate-refusal. New `GET /transfers` route. New agent tool `get_transfer_history`. Cursor is opaque (Ankr `{tx, token}` JSON).
- **2026-05-03 — Self-derived recipient SCA.** `helpers/aaConfig.ts` + `deriveScaAddress.ts` (1h LRU). `userProfile.repo.findByEoaAddress`; `eoa_address` lowercased on write. Resolver/sendCapability fall back to `deriveScaAddress` for un-onboarded recipients (previously returned EOA — funds unreachable). One-off script `scripts/verify-sca-derivation.ts` proved 100% match against Privy's derivation before enabling.
- **2026-04-28 — Delegation spend bookkeeping.** `signingRequest.usecase.resolveRequest` now calls `tokenDelegationDB.addSpent` when `tokenAddress`+`amountRaw` are present. `swapCapability` only tags the last step; `yieldCapability` deposits tag `plan.amountRaw`, withdrawals omit. `upsertMany` preserves `spent_raw` when `limit_raw` unchanged (was wiping FE permission bar).
- **2026-04-28 — Recipient notifications.** `RecipientNotificationUseCase` + `recipient_notifications` table. `dispatchP2PSend` (best-effort) at every successful p2p send via `buildNotifyResolved`. `flushPendingForTelegramUser` runs on `/start` + auth.
- **2026-04-28 — Ankr-backed portfolio.** `IBalanceProvider` port; `AnkrBalanceProvider` (single HTTP call) wrapped in `CachedBalanceProvider` (30s in-memory TTL). Feature-flagged via `PORTFOLIO_PROVIDER`. Fuji has no `ankrBlockchain` and always uses RPC.
- **2026-04-28 — Yield positions revamp.** Active-protocol discovery is on-chain (`OnChainPositionDiscovery` fans out across `protocol × stablecoin`); principal source is The Graph Messari Aave V3 subgraph. `yield_deposits` + `yield_withdrawals` tables **dropped** (`0026_stale_mandrill.sql`). `buildDepositPlan` no longer writes a DB row. `finalizeWithdrawal` is a no-op.
- **2026-04-27 — Sign-resolution UX.** Shared `helpers/notifyResolved.ts`. Decodes ERC-20 transfers; success → explorer link via `getExplorerTxUrl(chainId, txHash)`. `insufficient_token_balance` + USDC → `buy:y/<amount>` keyboard.
- **2026-04-27 — `/swap` + `/yield` UX parity with `/send`.** Single mini-app session per intent (step 1 emits `mini_app`; rest stored via `miniAppRequestCache`). `swapCapability` short-circuits USDC via `getUsdcAddress(chainId)`. Final swap completion includes explorer InlineKeyboard. swap bugfixes: pass `smartAccountAddress` (not EOA) to Relay; `chainId` on every step.
- **2026-04-27 — Global `$ → USDC` normalization.** `normalizeFiatAmount` runs in `OpenAISchemaCompiler.compile` for all capabilities.
- **2026-04-25 — Loyalty Program (Season 0).** `computePointsV1` formula, idempotent on `intent_execution_id`. Seven canonical action types: `swap_same_chain`, `swap_cross_chain`, `send_erc20`, `send_native`, `yield_deposit`, `yield_hold_day` (deferred), `referral`, `manual_adjust`. Fire-and-forget at all call sites. `LOYALTY_STATUSES` on `users`: `normal/flagged/forbidden`.
- **2026-04-25 — Cloud Run CI/CD + healthcheck + auth hardening.** `POST /health` (unauth, no secrets). Admin gate (`ADMIN_PRIVY_DIDS`) on `POST /tools`, `POST/DELETE /command-mappings`. Ownership gate on `GET /permissions`, `GET /request/:id` (non-auth). `POST /response` auth bypasses `resolveUserId`.
- **2026-04-24 — Scaling.** DB pool `max:25`. `MESSAGE_HISTORY_LIMIT=30`. OpenAI global concurrency cap. DateTime out of system prompt → prefix-cache stays warm. Privy `verifyTokenLite` LRU. Redis-backed `IPendingCollectionStore`. Multi-replica safe session reads (Postgres). Tavily + Relay quote cached in Redis. `ChainEntry.defaultRpcUrls` is `string[]` (viem `fallback`).
- **2026-04-24 — Swap (Relay).** `SwapCapability`. Aegis Guard check → `RelaySwapTool.execute` → per-step `SigningRequest`. Multi-step continuation via `?after=<prevId>` (Redis ZSET `user_pending_signs:<userId>`).
- **2026-04-24 — Yield optimizer.** Avalanche mainnet, Aave v3. `runPoolScan` / `scanIdleForUser` / `buildDepositPlan` / `finalizeDeposit` / `buildWithdrawAllPlan` / `buildDailyReport`. Ranking: `score = 0.7·EMA_7d(supplyApy) + 0.3·currentSupplyApy`; disqualify if liquidity < $100k; ×0.5 if utilization > 95%.
- **2026-04-24 — Structured logging.** All `console.*` migrated to pino. Singleton `helpers/observability/logger.ts:createLogger`.
- **2026-04-23 — Capability refactor.** All Telegram flows through `ICapabilityDispatcher`. `handler.ts` ~200 LOC (was 1146). `TriggerSpec.commands[]` for multi-command capabilities. Pending state must be JSON-safe.
- **2026-04-23 — Onramp `/buy`.** `BuyCapability` bypasses `selectTool`/manifests. `buy:y` → SCA address; `buy:n` → `OnrampRequest` mini-app.

## Backlog
- Proactive daily market sentiment → investment verdict agent.
- Aegis Guard agent-side enforcement: pre-UserOp re-check `limitRaw - spentRaw + validUntil`.
- `yield_hold_day` daily award (needs worker pass).
- Admin HTTP endpoint for `adjustPoints` (clawbacks).
- Cross-chain swap: destination-fill polling (`Relay /intents/status/v2`).
- Multi-stablecoin yield, partial withdrawal, additional yield adapters (Benqi/Yearn).
- Thread sender username through `CapabilityCtx.meta` so `recipient_notifications.senderHandle` is no longer always null.
