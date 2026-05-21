# Aegis Backend — Status

## What it is
Non-custodial, intent-based AI trading agent on Avalanche (and beyond). Hexagonal Architecture — use-cases depend only on interfaces; assembly in `src/adapters/inject/assistant.di.ts`. Users auth via Privy (Google or Telegram); Mini App passes `telegramChatId` to `POST /auth/privy`. Agent parses NL (incl. `$5` fiat shortcuts), classifies intent, compiles tool input schema, resolves fields, and executes via ERC-4337 UserOps through ZeroDev session keys. **Backend never signs transactions** — all signing via user delegated session keys in the mini-app.

> Capability-level details: `src/adapters/implementations/output/capabilities/status.md`. Result-card / error-catalog: `src/helpers/errors/{errorCatalog,status}.md`.

---

## 🚨 PRE-PRODUCTION SECURITY BLOCKERS — MUST FIX BEFORE MAINNET

> 2026-05-08 FE↔BE↔on-chain trust-boundary review. Fix order by severity. As each ships, move it to "Resolved" at file bottom with commit/PR.

| # | Sev | Location | Risk | Fix |
|---|---|---|---|---|
| 1 | 🔴 | `fe/.../crypto.ts:162-167` `toSudoPolicy({})` | Every session key can sign any UserOp to any contract for any amount. Spending limits enforced only by BE refusing to write oversized sign-requests — **no on-chain backstop**. BE compromise → mass drain. Supply-chain compromise → offline decrypt of blob+privyDid → unrestricted SCA control per user. | Replace with `toCallPolicy`/`toMerkleCallPolicy`: ERC-20 `transfer`/`approve` to whitelisted protocols, per-token caps, time-windowed allowances, swap routers + selector whitelist, Aave entry-points. BE returns canonical policy spec at install (FE can't weaken). On-chain spending-cap validator. Acceptance: Fuji UserOp to non-whitelisted contract reverts at validator (not BE); `transfer` above cap reverts on-chain. |
| 2 | 🔴 | `useDelegatedKey.ts`, `sessionEoa.ts:24` — password is `privyDid` | privyDid is an identifier (logs/Sentry/analytics/error reports), not a secret. Anyone with blob (TG CloudStorage) + privyDid (any log) decrypts offline. Combined with #1 = full SCA drain per leaked user. AES-GCM-256 + PBKDF2 100k is fine; password choice is the hole. | (a) Audit every observability sink for raw privyDid; redact or HMAC-hash; CI grep gate. (b) Replace password derivation with real secret — server-released per-user key (HSM/KMS, post-Privy-re-auth) OR WebAuthn/passkey-bound. (c) Rotate every blob on next open. |
| 3 | 🔴 | `PlaceBetHandler.tsx:184-200` | Polymarket setup approves `usdc.approve(ctfExchange, maxUint256)`, `usdc.approve(negRiskExchange, maxUint256)`, `ctf.setApprovalForAll(ctfExchange, true)`. Polymarket uses `signatureType=EOA` → standing approvals live on session-key EOA's Polygon address (not SCA). Privkey leak → drains bridged USDC + outcome tokens. SCA-side hardening doesn't help. | Per-bet exact-amount approvals: approve `stakeUsdc` immediately before `placeOrder`, reset to 0 after. Costs one extra UserOp per bet. Acceptance: post-bet, on-chain allowance from session-key EOA to both exchange contracts = 0; `setApprovalForAll` reset to `false` after position closes. |
| 4 | 🟠 | `SignHandler.tsx` auto-sign branch | Signs `(to,value,data)` with no decode, whitelist check, or human confirm. This is the vector for #1 at scale; also surface for prompt-injection if LLM ever directly enqueues sign-requests. | (a) BE signs every outbound `sign_request` with a key whose pubkey is pinned in FE bundle; FE verifies before signing. (b) BE writes decoded intent (fn, args, target, amount, counterparty); FE decodes independently and refuses on mismatch. (c) Force manual-confirm modal for high-value/unusual (>N% of cap, non-whitelisted target, unseen selector, new chain). (d) Per-user rate limit. |
| 5 | 🟠 | `useDelegatedKey.ts:329` `removeKey()` | Only wipes TG CloudStorage + memory. No BE `delegation/grant` delete, no on-chain plugin uninstall, no approval reset. Today effective (only user holds privkey), but once #2 is mitigated "Disconnect" label implies revocation while delivering only key deletion. | `DELETE /delegation/grant`; Disconnect asks user to sign one sudo UserOp uninstalling session-key plugin + zeroing approvals; rename to "Revoke bot access"; job to proactively expire+revoke past `validUntil`. |
| 6 | 🟡 | `fe/privy-auth/{package.json, vite.config.ts, index.html}` | No SRI, no strict CSP, no lockfile-hash gate, no `npm audit` gate, no integrity-pinned deps. One compromised npm dep exfils every user's blob + privyDid. | BE-served strict CSP (allowlist: BE API, Privy, TG WebApp, RPC/bundler/paymaster, CLOB; no inline scripts, eval, blob: workers). SRI on external assets (or bundle internally). CI gate: lockfile verify, `npm audit --audit-level=moderate`, no `^` ranges on crypto/wallet/RPC deps. Alert on FE→unknown-origin POSTs in prod. |
| 7 | 🟡 | BE sign-request writes | No rate-limit or anomaly detection. Attacker with DB write / BE-RCE writes 100k sign-requests in seconds. | Per-user rate limit (5/min, 50/hr). Anomaly detector flagging batched writes affecting many users (the #1 attack signature) — pause auto-delivery, require ops sign-off. Audit log table with use-case, requestId, intent hash. |

**2026-05-08 — #1 scoped partial fix (amount cap only).** FE replaces `toSudoPolicy({})` with `toSpendingLimitPolicy(limits)` seeded from `tokenDelegation` rows. New endpoint `GET /delegation/spending-limits?chainId=…` → `{chainId, limits:[{token,cap,validUntil}]}` from `tokenDelegationRepo.findActiveByUserId`. Same source of truth as `aegisGuardInterceptor`. **Residual risk accepted**: session key still callable to any contract (only token amount bounded); on-chain `cap` fixed at install — top-ups via `aegis_guard` update BE `limitRaw` only, validator still enforces original cap; native + unlisted-token transfers unbounded on-chain.

**Severity**: 🔴 mass-scale exploitable today — do not ship. 🟠 one-step or per-user exploitable — ship-blocking unless accepted. 🟡 reduces blast radius.

---

## Tech stack
| Layer | Choice |
|---|---|
| Language | TypeScript 5.3, Node.js, strict |
| Interface | Telegram (`grammy`) + HTTP (native `node:http`) |
| ORM | Drizzle + PostgreSQL (`pg`) |
| LLM | OpenAI (`gpt-4o` / configurable) |
| Blockchain | `viem` ^2 — any EVM, ERC-4337 |
| Account Abs | ZeroDev SDK (Kernel v3.1, EntryPoint 0.7) + `permissionless` ^0.2. SCAs **derived ourselves** via `helpers/aaConfig.ts` + `helpers/deriveScaAddress.ts` |
| Validation | Zod 4.3.6 |
| Cache | Redis via `ioredis` |
| Telegram | `grammy` + `telegram` (gramjs / MTProto) |
| Auth | Privy (`@privy-io/server-auth`) — no backend JWTs |
| Cross-chain | Relay (`RELAY_API_URL`) |
| Yield | Aave v3 (Avalanche mainnet) |
| Portfolio | Ankr (`ankr_getAccountBalance`) + RPC fallback |
| Transfers | Ankr (`getTransactionsByAddress` + `getTokenTransfers`) merged + cached |
| Prediction markets | Polymarket Gamma (scan) + CLOB (orderbook + signed-order forwarding). User Polygon SCA (Kernel v3.1, derived). Stake bridged Avax→Polygon via Relay. |
| Deployment | Fly.io (`aegis-core`, `iad`) + Neon Postgres + Upstash Redis |

## Non-negotiable rules
1. **Hexagonal.** Use-cases import only `use-cases/interface/`. No adapter-to-adapter imports. Assembly only in `assistant.di.ts`.
2. **No inline config literals.** Every `process.env.X` hoisted to top-of-file `const`. Chain-specific values in `chainConfig.ts`.
3. **No raw SQL.** Schema changes via `schema.ts` + `npm run db:generate && npm run db:migrate`.
4. **Privy-token-only auth.** `authUseCase.resolveUserId(token)` — never backend JWT.
5. **Time is seconds.** Always `newCurrentUTCEpoch()`. IDs always `newUuid()` (v4).
6. **New features = new Capabilities.** No flow logic in `handler.ts`.
7. **Backend never signs transactions.** `BOT_PRIVATE_KEY` / `IUserOpExecutor` removed 2026-04-24 — do not reintroduce.
8. **Loyalty awards are fire-and-forget.** Host txs must never depend on points succeeding.
9. **`POST /response` auth requests bypass `resolveUserId`.** Any endpoint that can create a user must verify via `loginWithPrivy` directly.
10. **AA stack constants exclusively in `helpers/aaConfig.ts`.** Never inline `entryPoint`, `kernelVersion`, `index`. FE + BE `aaConfig.ts` MUST stay in lockstep — drift silently changes a user's SCA.
11. **`eoa_address` is lowercased on write.** Lookups must lowercase.
12. **Native pseudo-address is `0xEeee…EEeE`.** Always `isNativeAddress(addr)` (case-insensitive). Never insert native rows into `tokenRegistry` — synthesized from chain config.
13. **Terminal capability outcomes are `result_card`, never `chat`.** `chat` is for intermediate ask/disambiguation. Capabilities never write MarkdownV2 — hand renderer plain strings via `IntentResult`; `escapeMd` runs in `resultCard.render.ts`. Exceptions go through `interpretError(err, {verb, requestId})` from `errorCatalog.ts` — never inline raw error strings.
14. **Sign-request previews go through `buildPreview`.** ERC-20 / native spend `sign_calldata` MUST set `preview: buildPreview({...})`. Multi-step: preview on FIRST step only (rest `undefined`; FE chains silently). Use `executeSignSteps({previews})` array variant only for distinct per-step modal labels.

## Project structure (essentials)
```
src/entrypoint.ts                     # Prod entry — migrate, dispatch by PROCESS_ROLE
src/{telegram,worker,http}Cli.ts      # Dev/worker/http entrypoints
src/use-cases/{implementations,interface/{input,output}}/
src/adapters/inject/assistant.di.ts   # Lazy-singleton wiring
src/adapters/implementations/{input,output}/
src/helpers/
  chainConfig.ts                      # CHAIN_REGISTRY + getViemChain/getRpcUrlForChain/
                                      # getNativeTokenInfo/NATIVE_PSEUDO_ADDRESS/isNativeAddress
  aaConfig.ts                         # AA stack constants — lockstep with FE
  deriveScaAddress.ts                 # Counterfactual SCA derivation (1h LRU)
  notifyResolved.ts                   # Shared sign-resolution Telegram notification
  decodeErc20Transfer.ts              # transfer(address,uint256) decoder
  observability/logger.ts             # pino createLogger
  errors/errorCatalog.ts              # PATTERNS + interpretError + ErrorCode
  crypto/aesGcm.ts                    # versioned envelope `v1:iv:tag:ct`
  env/                                # Per-feature env readers (never inline process.env)
  enums/                              # All enums
```
HTTP routing only via `exactRoutes`/`paramRoutes` in `httpServer.ts`. Jobs under `adapters/implementations/input/jobs/`. Telegram in `…/input/telegram/{bot.ts, handler.ts (~200 LOC)}`.

## Contract Registry
Default chain: Avalanche C-Chain mainnet (43114). `CHAIN_ID=43113` → Fuji.
- AegisToken (Fuji): `0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69`
- RewardController (Fuji): `0x519092C2185E4209B43d3ea40cC34D39978073A7` — prod via `REWARD_CONTROLLER_ADDRESS` env.
- Avalanche USDC aToken: `0x625E7708f30cA75bfd92586e17077590C60eb4cD`
- Aave V3 Messari subgraph: `72Cez54APnySAn6h8MswzYkwaL9KjvuuKnKArnPJ8yxb`
- Polymarket CTF Exchange (137): `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`; NegRisk: `0xC5d563A36AE78145C45a50134d48A1215220f80a`. Full addresses in `chainConfig.ts:CHAIN_REGISTRY[137].polymarket` via `getPolymarketConfig(chainId)`. Never inline.

## HTTP API
Port `HTTP_API_PORT` (4000). CORS *. Reqid = `newUuid().slice(0,8)`.

| Method | Route | Auth | Notes |
|---|---|---|---|
| `POST` | `/health` | None | Deployment metadata, no secrets |
| `POST` | `/auth/privy` | None | Verify token; upsert user + link TG session |
| `GET` | `/user/profile` | Privy | Cached profile |
| `GET` | `/portfolio` | Privy | On-chain SCA balances (Ankr or RPC) |
| `GET` | `/transfers?direction&limit&cursor&fromEpoch&toEpoch` | Privy | Ankr-backed. 429→`RateLimitedError` (Retry-After); 400→`UnsupportedChainError`. `Cache-Control: private, max-age=30` |
| `GET` | `/yield/positions` | Privy | Live positions + totals (on-chain probe) |
| `GET` | `/loyalty/{balance,history,leaderboard}` | Privy / leaderboard=None | |
| `GET` | `/tokens?chainId` | None | Verified tokens |
| `*` | `/tools`, `/command-mappings` | Admin/None | Dynamic tool manifests + command mappings |
| `*` | `/http-tools` | Privy | HTTP query tools (AES-256-GCM headers) |
| `GET` | `/permissions?public_key` | Privy + ownership | Session-key delegations |
| `GET/POST` | `/delegation/pending/:id[/signed]` | Privy | ZeroDev message lifecycle |
| `GET` | `/request/:requestId[?after=<id>]` | `auth`=None; else Privy+ownership | Mini-app polling |
| `POST` | `/response` | mixed | Mini-app result; `auth` bypasses `resolveUserId` |
| `GET/POST` | `/preference` | Privy | `aegisGuardEnabled` |
| `GET` | `/delegation/{approval-params,grant,spending-limits}` | Privy | Default tokens + suggested limits; list/upsert `token_delegations`; on-chain caps for #1 partial fix |
| `GET` | `/metrics` | Bearer (`METRICS_TOKEN`) | pgPool/openai/redis/LLM metrics |
| `*` | `/predictionMarket/*` | Privy | 12 routes: setup state machine, bet intent lifecycle, bet execution, orderbook, position list, `/state`. 409 on illegal bet transitions; 503 when `PREDICTION_MARKETS_BETS_ENABLED=false` |
| `GET` | `/admin/prediction-markets/shadow-agreement?windowDays=7` | `PREDICTION_MARKETS_ADMIN_HTTP_TOKEN` | Per-subject deterministic vs LLM agreement |

## Telegram commands
| Command | Behavior |
|---|---|
| `/start /auth /logout /new /history /confirm /cancel /portfolio /wallet /sign` | Auth + meta |
| `/buy <amount>` | BuyCapability — onramp keyboard (SCA address or MoonPay mini-app) |
| `/send /money /convert /topup /dca /sell` | SendCapability — compile→resolve→Aegis Guard→sign (native + ERC-20 both auto-sign) |
| `/swap` | SwapCapability — Relay cross/same-chain |
| `/yield /withdraw` | YieldCapability — Aave v3 deposit/withdraw; handles `rebalance:y/n` (sticky-winner switch via `withdrawAll(old) → supply(new)` one mini-app session) |
| `/points /leaderboard` | LoyaltyCapability |
| _(callback `place_bet:findingId:marketId:A\|B`)_ | PlaceBetCapability — confirm-amount card → write bet row → deep-link. Avax→Polygon bridge, then EOA-signed Polymarket order. Receipts via `PredictionMarketReceiptBroadcaster`. Gated on `_BETS_ENABLED=true` |
| _(callback `close_position:positionId`)_ | ClosePositionCapability — re-quote on confirm, open close bet, sell-side order. `position_closed`/`position_resolved` via receipt broadcaster + `PolymarketPositionPollerJob` |
| _(text)_ | AssistantChatCapability — chat + tool-call loop |
| _(photo)_ | Vision chat with caption |

## Intent / message flow
```
message
  ├─ slash command   → CapabilityDispatcher  (fresh match → resume pending → free-text)
  └─ free text       → classifyIntent → toolIndex → schemaCompiler
                             ↓
                       ResolverEngine (token symbols, amounts, @handle via MTProto+Privy;
                                       handle path → SCA via DB or deriveScaAddress for un-onboarded)
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
| `conversations`, `messages` | Per-user threads; all turns (user/assistant/tool/assistant_tool_call) |
| `user_profiles` | SCA, EOA (lowercased), session key, scope, status, telegramChatId. `findByEoaAddress(eoa)`. |
| `token_registry` | symbol → addr+decimals per chainId. **Native tokens synthesized**, not stored. |
| `intents`, `intent_executions` | Lifecycle + per-attempt (userOpHash, txHash, fees). Write-free since NL unification — kept for transferHistory enrichment. |
| `tool_manifests` | toolId, steps JSON, inputSchema, chainIds, priority |
| `pending_delegations` | Queued ZeroDev messages |
| `fee_records` | Protocol fee audit |
| `command_tool_mappings` | bare word → toolId |
| `http_query_tools` + `http_query_tool_headers` | Dev HTTP tools (AES-encrypted headers) |
| `user_preferences` | `aegisGuardEnabled` |
| `token_delegations` | `limitRaw`, `spentRaw`, `validUntil` per token. Native valid (`tokenAddress = NATIVE_PSEUDO_ADDRESS`). `upsertMany` preserves `spent_raw` when `limit_raw` unchanged. |
| `yield_position_snapshots` | Snapshots only — deposits/withdrawals tables dropped 2026-04-28. |
| `loyalty_seasons`, `loyalty_action_types`, `loyalty_points_ledger` | Action types: `swap_same_chain`, `swap_cross_chain`, `send_erc20`, `send_native`, `yield_deposit`, `yield_hold_day` (deferred), `referral`, `manual_adjust`. |
| `recipient_notifications` | P2P send notifications (pending/delivered/failed) |
| `prediction_market_runs` | One per scan tick. `universeHash`, `clusterSetHash`, `status`, `is_latest` (atomically flipped via `setLatestRun` txn — only sanctioned way) |
| `prediction_market_snapshots` | Top-100 markets/run. Money as **cents** (bigint); prices as **bps** (integer 0..10000). PK `(run_id, market_id)`. |
| `prediction_market_clusters` | LLM-derived causal clusters (≥3 marketIds). `marketIds` + `expectedRelationships` JSONB. Carry-forward runs preserve prior `cluster_id`. Nullable `derived_subject` (deterministic clusterer only). |
| `prediction_market_findings` | Stage-3 verified findings. `cluster_id` stable across runs. `magnitude_bps` + `rank_score` (×1000 to fit `integer`). `broadcasted_at_epoch` set after fan-out. Indexed by `run_id`, `cluster_id`, `created_at_epoch`. Optional `sized_trades jsonb`, `expected_profit_usdc_cents`, `min_payoff_usdc_cents`. |
| `prediction_market_facts` | Per-market canonical extraction (PK `market_id`). **`regex_verified=false` rows MUST NOT enter the deterministic hot path** — review-queue only. |
| `prediction_market_extraction_reviews` | Admin review queue. |
| `prediction_market_clusters_shadow`, `prediction_market_findings_shadow` | Shadow-mode deterministic output. Never broadcasts, never feeds sizer. |

## Redis key schema
| Key | TTL | Value |
|---|---|---|
| `delegation:{sessionKeyAddress}` | none | `DelegationRecord` |
| `sign_req:{id}` | `max(10s, expiresAt-now)` | signing request |
| `mini_app_req:{requestId}` | 600s | `MiniAppRequest` |
| `user_pending_signs:<userId>` (ZSET) | maintained | per-user pending sign index |
| `user_profile:{userId}` | min 10s | `PrivyUserProfile` |
| `pending_collection:{channelId}` | `min(expiresAt-now, 1h)` | `PendingCollection` |
| `tavily:{sha1(...)}` | 300s | search response |
| `relay_quote:{sha1(...)}` | 15s | RelayQuote |
| `transfers:{userId}:{...}` + stale companion | `TRANSFER_HISTORY_PAGE_TTL_SEC` | transfer page (day-bucketed) |
| `transfers:user_window:{userId}`, `transfers:global_bucket` | rolling, per-second | RPM / RPS gates |
| `yield:best:{chainId}:{token}` | 3h | `{protocolId,score,apy,ts}` |
| `yield:apy_series:{chainId}:{protocolId}:{token}` | none | list (84 samples) |
| `yield:{nudge_cooldown,nudge_pending}:{userId}` | `YIELD_NUDGE_COOLDOWN_SEC` | `"1"` |
| `yield:report_done:{YYYY-MM-DD}` | 25h | `"1"` |
| `yield:winner_streak:{chainId}:{token}` | `4 × poolScanIntervalMs` | sticky-winner hysteresis for auto-rebalance |
| `yield:{rebalance_cooldown,rebalance_pending}:{userId}` | 24h, 1h | rebalance nudge cooldown / in-flight |
| `loyalty:season:active`, `loyalty:leaderboard:{seasonId}:{limit}` | 60s, 30s | |
| `pm:scan:lock` | `0.9 × FETCH_INTERVAL_MS` | per-tick scan lock (`SET NX PX`) |
| `pm-cluster:{promptVersion}:{model}:{sha256(sortedMarketIds@resolutionEpochs)}` | 24h | cached `DraftCluster[]` |
| `pm:broadcast:lastHash:{userId}` | 7d | last `clusterSetHash` delivered |
| `pm-detect:{sha256(clusterId + sortedMembers@bucketedYesPriceBp + promptVersion + model)}` | 1800s | cached `DraftFinding[]`. YES prices bucketed (50bp default) so flat ticks hit, real movement misses. |
| `pm:finding:lastSeen:{userId}:{findingId}` | 7d | per-user dedupe. Cross-run dedupe intentionally NOT applied. |
| `pm:extract:lock` | `EXTRACT_INTERVAL_MS` | per-tick extractor lock |

## Key environment variables
| Variable(s) | Default | Purpose |
|---|---|---|
| `DATABASE_URL` / `DB_POOL_MAX` | `postgres://localhost/aether_intent` / `25` | Pool budget: replicas×25 + 1 ≤ max_connections |
| `REDIS_URL` | — | Optional; adapters fall back to in-memory |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_CONCURRENCY` | — / `gpt-4o` / `6` | Per-replica p-limit |
| `TELEGRAM_BOT_TOKEN`, `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` | — | Telegram + MTProto |
| `HTTP_API_PORT`, `MINI_APP_URL` | `4000` / — | Fly `internal_port=4000` |
| `CHAIN_ID`, `RPC_URL`, `RPC_URL_FALLBACKS` | `43114` | Comma-separated fallbacks |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFY_CACHE_TTL_MS`, `PRIVY_VERIFY_CACHE_MAX` | — / `300000` / `5000` | LRU verifyTokenLite |
| `ANKR_API_KEY`, `PORTFOLIO_PROVIDER` | — / `ankr` (\|`rpc`) | Optional Ankr. Shared by portfolio + transfer history. |
| `TRANSFER_HISTORY_RPM_USER`, `_RPS_GLOBAL`, `_PAGE_TTL_SEC`, `_PAGE_OLDER_TTL_SEC`, `_STALE_TTL_SEC` | — | `/transfers` rate guards + cache TTLs |
| `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `PINECONE_HOST` | — | Tool index |
| `TAVILY_API_KEY`, `TAVILY_CACHE_TTL_SECONDS` | — / `300` | Web search |
| `RELAY_API_URL`, `RELAY_QUOTE_CACHE_TTL_SECONDS` | `https://api.relay.link` / `15` | Cross-chain |
| `THEGRAPH_API_KEY` | — | Messari Aave V3 subgraph. Absent → PnL=0. |
| `REWARD_CONTROLLER_ADDRESS` | — | `ClaimRewardsSolver` target |
| `HTTP_TOOL_HEADER_ENCRYPTION_KEY` | — | 32-byte hex AES-256-GCM |
| `MAX_TOOL_ROUNDS`, `MESSAGE_HISTORY_LIMIT` | `10` / `30` | Assistant guardrails |
| `PROCESS_ROLE` | `combined` | `worker` \| `http` \| `combined` |
| `METRICS_TOKEN`, `ADMIN_PRIVY_DIDS` | — | `/metrics` bearer; admin DIDs (unset=403) |
| `LOG_LEVEL`, `LOG_PRETTY` | `info` (prod) | pino config |
| `YIELD_IDLE_USDC_THRESHOLD_USD`, `_POOL_SCAN_INTERVAL_MS`, `_USER_SCAN_INTERVAL_MS`, `_NUDGE_COOLDOWN_SEC`, `_ENABLED_CHAIN_IDS` | `10` / `1800000` / `1800000` / `1800` / `43114` | Yield cadences + nudge |
| `YIELD_REBALANCE_{CHECK_INTERVAL_MS, MIN_DELTA_BPS, STICKY_SCANS, NUDGE_COOLDOWN_SEC}` | `86400000` / `50` / `3` / `86400` | Auto-rebalance |
| `YIELD_REPORT_UTC_HOUR`, `_INTERVAL_MS` | `9` / unset | Daily report hour; `INTERVAL_MS>0` skips daily gate (debug) |
| `LOYALTY_ACTIVE_SEASON_CACHE_TTL_MS`, `_LEADERBOARD_CACHE_TTL_MS` | `60000` / `30000` | |
| `PREDICTION_MARKETS_ENABLED`, `_FETCH_INTERVAL_MS`, `_GAMMA_API`, `_MAX_FETCH_PAGES`, `_TOP_N` | `false` / `1800000` / `https://gamma-api.polymarket.com` / `4` / `100` | Scan toggle + cadence |
| `PREDICTION_MARKETS_MIN_OI_USD`, `_MIN_7D_VOLUME_USD`, `_MIN_DAYS`, `_MAX_DAYS` | `50000` / `20000` / `3` / `60` | Stage-1 filters (plus binary YES/NO + non-empty resolution criteria + `acceptingOrders=true`), ranked by liquidity, capped to `TOP_N` |
| `PREDICTION_MARKETS_CLASSIFIER_MODEL`, `_MAX_CRITERIA_CHARS`, `_PROMPT_VERSION`, `_CLUSTER_CACHE_TTL_SEC` | `gpt-4o` / `4000` / `v1` / `86400` | Stage-2 (structured outputs strict) |
| `PREDICTION_MARKETS_RECLUSTER_DELTA`, `_MAX_RECLUSTER_AGE_MS` | `10` / `86400000` | Stage-2 trigger |
| `PREDICTION_MARKETS_BROADCAST_CONCURRENCY` | `5` | Per-tick `pLimit` |
| `PREDICTION_MARKETS_FINDINGS_ENABLED` | `false` | Stage-3 dark-launch. Read once at `runOnce`; independent of `_ENABLED`. |
| `PREDICTION_MARKETS_DETECTOR_MODEL`, `_CONCURRENCY`, `_CACHE_TTL_SEC`, `_PRICE_BUCKET_BPS` | `${classifierModel}` / `3` / `1800` / `50` | Stage-3 detector. Smaller bucket = more misses, fresher. |
| `PREDICTION_MARKETS_VERIFY_FRESHNESS_MS`, `_ODDS_DRIFT_TOLERANCE_BPS`, `_MIN_GAP_BPS`, `_FINDING_MIN_LIQUIDITY_USD` | `60000` / `50` / `100` / `25000` | Stage-3 verifier gates |
| `PREDICTION_MARKETS_POLYMARKET_AFFILIATE` | `""` | Optional `?affiliate=…` on Polymarket URL buttons |
| `PREDICTION_MARKETS_DETERMINISTIC_SUBJECTS` | `""` | Empty=100% LLM. Listed subjects routed to deterministic clusterer/detector (requires regex-verified facts). |
| `PREDICTION_MARKETS_SHADOW_MODE` | `false` | Run deterministic alongside LLM on full universe; write to `*_shadow` tables. |
| `PREDICTION_MARKETS_EXTRACT_INTERVAL_MS`, `_EXTRACTOR_CONCURRENCY` | `3600000` / `8` | Hourly redis-locked extractor |
| `PREDICTION_MARKETS_REVIEW_ADMIN_CHAT_ID`, `_REVIEW_QUEUE_ALERT_THRESHOLD` | — / `10` | Admin TG chat + queue depth alert |
| `PREDICTION_MARKETS_SIZING_ENABLED`, `_SIZER_BUDGET_USDC`, `_SIZER_FEE_BPS`, `_SIZER_GAS_ESTIMATE_USDC`, `_SIZER_DEPTH_LEVELS` | `false` / `100` / `200` / `0.05` / `10` | LP sizing. **Inert without `outcomeTokenIdResolver` wired into verifier.** |
| `PREDICTION_MARKETS_BETS_ENABLED` | `false` | Real-money pipeline. 503 on `/predictionMarket/*` when false. |
| `PREDICTION_MARKETS_ADMIN_HTTP_TOKEN` | — | Bearer for `/admin/prediction-markets/*` |
| `RESULT_CARD_INTERPRETER_ENABLED`, `_INTERPRETER_MODEL` | `false` / `gpt-4o-mini` | Result-card LLM. Env-gated AND `OPENAI_API_KEY`. Only fires on `complexity==="complex"`. 2s timeout, ≤25 words, Redis cache `interp:` 5-min. All reads via `getResultCardEnv()` — never inline. |

## Coding conventions
- **IDs**: `newUuid()` only. **Timestamps**: `newCurrentUTCEpoch()` (seconds). Columns end `AtEpoch`.
- **Enums**: prefer `helpers/enums/` over inline strings. `parseIntentCommand` is the only slash matcher.
- **Cache types** (`MiniAppRequest`/`DelegationRecord`) live under `interface/output/cache/` — no cross-layer leakage.
- **DB facade**: single `DrizzleSqlDB`; repos hang off as `db.users`, `db.toolManifests`, etc. Use-cases receive the repo interface, never the facade.
- **Lazy singletons** in `AssistantInject`: `if (!this._x) this._x = new X(...)`. Optional-env services return `undefined` when unconfigured.
- **HTTP routing**: `exactRoutes` or `paramRoutes` only. No if/else chains.
- **Encrypted secrets**: `helpers/crypto/aesGcm.ts` versioned envelope `v1:iv:tag:ciphertext`. Used for at-rest Polymarket L2 creds. Future rotations append `v2:`, never mutate in place.
- **Logging (pino)**: `createLogger('ScopeName')`. Metadata is **first** arg. Never `console.*`. Never log tokens, privyDid, signatures, raw PII. Common fields: `step`, `reqId`/`userId`, `err`, `durationMs`, `status`, `attempt`, `choice` (cache hit/miss), `count`, `source`, `stale`, `betCount`, `groupBy`, `detectorSource`.
- **Free-tier external providers**: wrap adapter in `CachedXxxProvider(inner, cache, userId, cfg)` decorator using `acquireUserSlot(userId, rpm)` + `acquireGlobalSlot(rps)`. Never inline rate-limit logic. Use `RateLimitedError` / `UnsupportedChainError` (HTTP maps to 429/400).
- **Spend bookkeeping**: ERC20-spend autosign signing-requests MUST set `tokenAddress` (lowercased) + `amountRaw` (decimal raw string) on the SigningRequestRecord/`sign_calldata` of the **single tx that actually moves user funds** — typically the last step. Native paths leave both undefined. `signingRequest.usecase.resolveRequest` calls `tokenDelegationDB.addSpent(...)` best-effort.
- **Multi-step capabilities**: emit `mini_app` for step 1 only; store steps 2..N via `miniAppRequestCache.store(...)`; FE chains via `GET /request/:id?after=<prev>`. One mini-app session per intent.
- **Fiat normalization**: `OpenAISchemaCompiler.compile()` runs `normalizeFiatAmount(text)` before LLM — `$N`/`N dollars/bucks/usd` → `N USDC`. Inherited by new capabilities; don't re-implement.
- **Recipient resolution**: `eoa → DB profile.smartAccountAddress` if onboarded, else `deriveScaAddress(eoa, chainId)`. DB row always wins.
- **Soft-fail capability boot**: external-invariant-dependent capabilities expose `async verifyXCapability()` (or DI getter returning `undefined`) on `AssistantInject` that swallows errors and flips `_xCapabilityDisabled`. CLIs `await` it. HTTP routes guard via `isXCapabilityDisabled()` → `503 {error:"x_unavailable"}`. Mirror for any new chain-bound capability.
- **Per-step `chainId` on cross-chain plans**: each step in a multi-step plan carries its own `chainId` so one mini-app session can sequence home-chain bridge legs and venue-chain action legs. Pattern: `predictionMarketBetUseCase`.
- **`spendTokenAddress` only on the LAST home-chain leg** of multi-step cross-chain plans (mirrors `swapCapability`). Tagging a venue-chain leg attributes spend against a delegation row that doesn't exist for that token.
- **Bet-state transitions repo-enforced.** `updateBetStatus` does `SELECT … FOR UPDATE` in txn, validates against `BET_STATE_TRANSITIONS`; illegal → `IllegalBetTransitionError` → HTTP 409. Never absorb. Setup-step transitions linear-monotonic (forward-by-≤1 or same).
- **Per-feature `__tests__/`** for pure modules under `use-cases/interface/.../`. Excluded from tsc via `tsconfig.exclude: ["src/**/__tests__/**"]`. Run with `npx tsx --test <path>`. `be/tests/*.test.ts` remains valid for cross-cutting.

## Extension patterns
- **New system tool**: `ITool` → `SystemToolProviderConcrete.getTools()`.
- **New DB table**: `schema.ts` → repo interface → Drizzle impl → `DrizzleSqlDB` → DI → `db:generate && db:migrate`.
- **New solver**: `ISolver` in `output/solver/` → register under correct `INTENT_ACTION`.
- **New HTTP route**: `exactRoutes`/`paramRoutes`. Signature: `(req, res, url, ...params) => Promise<void>`.
- **New Capability**: implement `Capability`, register in `AssistantInject.getCapabilityDispatcher()`. Reserve unique `triggers.callbackPrefix`.
- **New sign-error code**: add to FE `interpretSignError.ts` AND BE `notifyResolved.ts` recovery branch. String is the contract.
- **New chain**: one `CHAIN_REGISTRY` entry; set `ankrBlockchain` if Ankr supports it. Native auto-synthesized from viem's `Chain.nativeCurrency`.
- **New external provider port**: define `IXxxProvider` under appropriate `interface/output/` subdir. Implement `CachedXxxProvider` decorator with rate-guard template.
- **New read-only agent tool**: `ITool` under `output/tools/`, add to `TOOL_TYPE`, register in provider. Soft-disable: take `isDisabled: () => boolean` and return `{success:false, error:"<feature>_unavailable"}`. Never autosign or mutate.
- **New cross-chain capability**: (a) chain in `CHAIN_REGISTRY`; (b) adapter port(s) under `interface/output/<feature>/`; (c) per-step `chainId`; (d) soft-disable getter + 503 path; (e) flip `relayEnabled: true` once round-trip smoke-tested.

## NL/intent routing convention (2026-05-05 unification)
Free-text "swap …" / "send …" / "deposit into yield" route through the **same** `route_intent` LLM tool as `/`-prefixed commands. Byte-identical signing payloads, same Aegis-Guard gate. New capabilities reach NL by adding their `INTENT_COMMAND` to `routeIntent.tool.ts:COMMAND_VALUES` — no per-feature LLM tool. **Removed (do not reintroduce)**: `ExecuteIntentTool`, `TransferErc20Tool`, `OpenAIIntentParser/Classifier`, `IIntentParser/Classifier`, `ClaimRewardsSolver`, `validateIntent`, `IntentUseCase.{parseAndExecute, classifyIntent}`, `intent.errors`, `execute_intent` tool. **Kept (load-bearing)**: `IntentUseCase.{searchTokens, selectTool, compileSchema, buildRequestBody, generateMissingParamQuestion}`, `SolverRegistry` + `ManifestDrivenSolver`, `ISchemaCompiler`.

**Capability calldata convention (2026-05-05 dynamic-tool-registry drop)**: capabilities register their own `CapabilityManifest` constant inline and build calldata directly (e.g. `sendCapability.SEND_MANIFEST` + private `buildTransferCalldata` mirroring `executeErc20Transfer` byte-for-byte: native = recipient/`0x`/value-raw; ERC-20 = `viem.encodeFunctionData(erc20Abi, "transfer", …)`). `IIntentUseCase` exposes only `searchTokens`/`compileSchema`/`generateMissingParamQuestion`.

## Auto-resume convention
Capabilities returning `kind:"mini_app"` for an `aegis_guard` reapproval MUST persist resolved params via `IPendingIntentStore` keyed by `guard.reapprovalRequest.requestId`. `dispatcher.resume()` is the ONLY sanctioned way to re-enter a capability with already-resolved params. Swap params include `forceRequote?: boolean` set on resume. http-only `httpCli` has no dispatcher — falls back to "please re-issue".

## Polymarket adapter — custom HTTP, NOT `@polymarket/clob-client`
SDK depends on ethers v5; codebase is viem-only. Adapter wraps `/auth/api-key`, `/book`, `POST /order`, `DELETE /order`, `/data/order/:id`, `/data/positions` with L2 HMAC headers. EOA-signed orders forwarded verbatim from FE. ABI-compatible with `ClobClient` shape — swap is mechanical.

## Bet pipeline conventions (load-bearing)
(i) `updateBetStatus` validates against `BET_STATE_TRANSITIONS` inside `SELECT … FOR UPDATE` txn → 409 on illegal. Never absorb. (ii) Setup-step transitions linear-monotonic. (iii) One in-flight bet per user (`countOpenBetsForUser` excludes terminal; PARTIAL counts as in-flight until refund lands). (iv) Refunds on EOA after non-fill terminations are in-band `refundRequired` flag on bet row; FE submits paymaster-sponsored EOA→SCA sweep on next mini-app open. (v) Receipts pushed by `IPredictionMarketReceiptBroadcaster` (telegram-direct), never inline. (vi) Polymarket maker calls funnel through `IPolymarketAdapter` with explicit `makerAddress` + creds-envelope params — no stored client. (vii) When local position diverges from `/data/positions`, **Polymarket wins**. (viii) Position lifecycle: `open → closing → closed` (user), `open → resolved` (Polymarket), `open → closed` (silent manual web close). (ix) `clientOrderId` (uuid, UNIQUE) is Polymarket idempotency key. (x) Write-side and read-side prediction-market repos stay split. (xi) Polymarket exchange/CTF/NegRisk addresses exclusively in `chainConfig.ts:CHAIN_REGISTRY[137].polymarket`.

## Deterministic prediction-market detection — invariants
- Six pure violation primitives in `relationshipPrimitives.ts`: `subset`, `partition_exhaustive`, `partition_nonexhaustive`, `temporal_nested`, `complement`, `conditional`. Each returns `{violationBps, roles}` or null with explicit `tolBps`. 100% line coverage required; new primitive ⇒ replay fixture in same PR.
- Detector emits role tags (`wider_market_id`, `narrower_market_id`, `earlier_market_id`, `later_market_id`) as nullable-required JSON-schema fields. Findings missing required pair → drop `missing-role-tag`. Verifier directional check: nested → `P(narrower) − P(wider)`; term_structure → `P(earlier) − P(later)`; non-positive → drop `wrong-direction`.
- **`prediction_market_facts.regex_verified=false` MUST NOT enter the deterministic hot path.**
- **Resolution-source compatibility** (per `RESOLUTION_COMPATIBILITY`): crypto spot sources (Coinbase / Coingecko / Kraken) pairwise INCOMPATIBLE — "BTC ≥ 95k by Coinbase vs Coingecko" is oracle disagreement, not arb. UMA + league-score only self-compatible. `OTHER` is subject sentinel — unmatched markets go there AND review queue.
- **LP sizing** inert until `PREDICTION_MARKETS_SIZING_ENABLED=true` AND `outcomeTokenIdResolver: (marketId) => {yes,no}` injected into verifier. Without resolver, `maybeSize` warns and finding survives un-sized.
- **Promotion checklist (per subject)**: ≥7 consecutive days shadow agreement ≥95%; every shadow-only + LLM-only finding manually reviewed; sized findings ≥30% positive expected-profit; one staging week in `_DETERMINISTIC_SUBJECTS`; prod promote via env-var only. LLM detector teardown deferred until every active subject promoted ≥30 days.

## Stage 1–3 prediction-market invariants
- **Stage 1+2**: worker-only job, every `_FETCH_INTERVAL_MS` (30min default). Stage 2 LLM clustering runs only on universe-hash change OR > `RECLUSTER_DELTA` churn OR > `MAX_RECLUSTER_AGE_MS`. Classifier uses structured outputs (`response_format: json_schema, strict`). Overlapping market_ids dropped lower-confidence-first. Multi-replica safe via `pm:scan:lock`. Money cols `bigint` cents; prices `integer` bps.
- **Stage 3**: per-tick `detect → verify → broadcast`. Patterns: `logical_inconsistency` / `term_structure_anomaly` / `implied_contradiction` / `movement_divergence`. Verifier drops on hallucinated ids, sub-$25k liquidity, >50bp odds drift, pattern-gap < 100bp. `rankScore = patternWeight × confidenceWeight × min(gap/1000, 1) × log10(minLiquidity)` (×1000 to fit `integer`). Per-user dedupe via `pm:finding:lastSeen` (7d) — cross-run dedupe intentionally absent. Carry-forward stable cluster IDs across cache-hit reclusters.
- **Cluster broadcast suppressed** (2026-05-07): `getPredictionMarketScanUseCase` passes `null` for cluster broadcaster; only per-finding messages reach users. Class + DI getter + `pm:broadcast:lastHash` retained for one-line revert.

## Native + send/swap/yield invariants
- **Native via synthesis**: `NATIVE_PSEUDO_ADDRESS` + `getNativeTokenInfo(chainId)`; `DbTokenRegistryService` synthesizes native row. `manifestSolver/stepExecutors.executeErc20Transfer` branches on `isNativeAddress` → `{value: amountRaw, data: "0x"}`.
- **Self-derived recipient SCA** (2026-05-03): resolver/sendCapability fall back to `deriveScaAddress` for un-onboarded recipients (was returning EOA — funds unreachable). `scripts/verify-sca-derivation.ts` proved 100% match against Privy.
- **Swap**: pass `smartAccountAddress` (not EOA) to Relay; `chainId` on every step. `swapCapability` short-circuits USDC via `getUsdcAddress(chainId)`. Final completion includes explorer InlineKeyboard.
- **Yield**: EMA ranker `α = 2/(N+1)` on newest-first APY history. Aave V3 APY formula verified against `aave-utilities` `calculateCompoundedInterest`. Ranking: `score = 0.7·EMA_7d(supplyApy) + 0.3·currentSupplyApy`; disqualify if liquidity < $100k; ×0.5 if utilization > 95%. **Active-protocol discovery is on-chain** (`OnChainPositionDiscovery`); principal from Messari Aave V3 subgraph. `yield_deposits`/`yield_withdrawals` tables dropped 2026-04-28; positions are snapshots. `finalizeWithdrawal` re-discovers + `upsertSnapshot` per (chain, protocol, token); failures `warn`, never rethrow. `SubgraphPrincipalProvider.status(): "ok"|"degraded"|"disabled"` surfaced via `/health`.
- **Auto-rebalance** (2026-05-04): switch must persist `YIELD_REBALANCE_STICKY_SCANS=3` consecutive scans before nudging. Both `yield:` and `rebalance:` callback prefixes owned by `YieldCapability` (`TriggerSpec.callbackPrefix: string | string[]`). On rebalance only the supply leg gets `tokenAddress + amountRaw` (withdraw burns aTokens). Path stays dormant in production without a second adapter.
- **Sign-resolution UX**: shared `helpers/notifyResolved.ts`. Decodes ERC-20 transfers; success → explorer link via `getExplorerTxUrl(chainId, txHash)`. `insufficient_token_balance` + USDC → `buy:y/<amount>` keyboard.
- **Sign-error diagnostics** (2026-05-05): `POST /response` schema has optional `errorRaw: string (≤1024)`. `resolveRequest` emits `warn step:"signing-request-rejected-raw"`. **Diagnostic-only — never re-displayed, never persisted.**

## Result-card framework (P1→P7+)
Single canonical capability outcome shape (`IntentResult`) with `result_card` artifact. Renderer (`artifactRenderer/resultCard.{render,escape}.ts`) is the **only** place touching Telegram MarkdownV2; `escapeMd` runs over every capability-supplied substring. New verbs → `IntentVerb`; new error codes → `ErrorCode` AND its `PATTERNS` table. `complexity:"complex"` reserved for cross-chain swaps + multi-step + yield rebalance — single-token sends and same-chain single-step swaps default to `"simple"` so interpreter never fires. Read-only query capabilities emit `result_card{status:"success"}` even on empty path. `IIntentInterpreter` (OpenAI, 2s timeout, optional Redis cache `interp:` 5-min, ≤25 words) gated by `RESULT_CARD_INTERPRETER_ENABLED` AND `OPENAI_API_KEY`.

---

## Drizzle migrations — handle with extreme care

`drizzle/` is merge-hostile. `_journal.json`, per-migration `meta/*_snapshot.json`, and sequential `NNNN_*.sql` filenames all collide across branches. This repo has dual `0016_*.sql`, a missing `0019_*`, and at least one merge silently dropped an `ALTER TABLE users ADD COLUMN privy_did` — login broke in prod.

- **Always rebase onto main before `drizzle-kit generate`.** Never hand-resolve conflicts in `drizzle/` — abort, drop local migrations, rebase, regenerate.
- **Never delete or rename a migration that landed on main.** Its hash is in `__drizzle_migrations`.
- **Never fix drift with raw SQL.** Use `npx drizzle-kit generate --custom --name <reason>`.
- **`migrate.ts` always prints "all migrations applied" — unconditional.** Verify with `SELECT * FROM drizzle.__drizzle_migrations` and `\d <table>`.
- **Drift check**: drizzle diffs `schema.ts` against latest snapshot, not the live DB. Inspect DB directly.
- **`_journal.json` `when`-ordering caveat**: drizzle orders by `when`, not `idx`, and silently skips any entry whose `when` is older than max `created_at` in `drizzle.__drizzle_migrations`. Historical entries (idx 31–34) are hand-set to `1778889600000+`. New entries get real `Date.now()` (older) → `db:migrate` prints "all applied" but silently skips. **Always verify post-migrate** via `information_schema.columns`. If missing, bump new entry's `when` to one tick above prior max (`1778889600003`, `1778889600004`, …) and re-run. Edit `_journal.json` only — never SQL or ledger.
- If `drizzle/` looks structurally weird (duplicate prefixes, gaps, wrong `idx`), stop and surface it.
- **`int4` season `validUntil` sentinel is `2147483647`** (year-2038). `9999999999` overflows and crashed migration once.

---

## Production topology (Fly.io, `aegis-core`, `iad`)

Single combined machine (`PROCESS_ROLE=combined` — http + worker + telegram in one node). `min_machines_running=1`, `auto_stop_machines="off"`, `auto_start_machines=true`. VM `shared-cpu-2x`, 2 cpus, 2gb. HTTP `internal_port=4000`, `force_https=true`, `soft_limit=200`/`hard_limit=250`. TCP healthcheck on `:4000`. Boot runs migrations. **Combined process owns gramJS MTProto socket + cron timers — `auto_stop_machines="off"` mandatory; do not raise replica count without first sharding telegram polling and cron locks (>1 replica duplicates both).** External: Neon Postgres + Upstash Redis (`us-east-1`).

**Secrets**: `fly secrets set --app aegis-core`. Source of truth is gitignored `be/fly-secrets.sh` (idempotent). Workflow: edit script → `./fly-secrets.sh` (uses `--stage`) → `fly deploy`. Non-secret env inline in `fly.toml [env]`.

**Image build**: two-stage `node:20.19-slim` (debian/glibc so `prebuild-install` finds glibc prebuilts for `bufferutil`/`utf-8-validate`). Builder `apt-get install python3 make g++` under BuildKit cache mounts. `npm ci --prefer-offline` cached, esbuild bundle `src/entrypoint.ts → dist/server.js` (minified, **no sourcemap** — re-add `--sourcemap=external` outside runtime COPY if wiring Sentry). **Layer ordering**: `package*.json` + `npm ci` come BEFORE `tsconfig.json`/`src/`, so src-edit rebuild only re-runs esbuild (seconds). Build-arg `MINIFY` (default `true`) — `--build-arg MINIFY=false` for ~3× faster esbuild / 3× larger bundle. **Required runtime native modules**: gramjs/`websocket` hard-requires `bufferutil` (no JS fallback) — copy `bufferutil`, `utf-8-validate`, `node-gyp-build` from builder into runtime stage. Drizzle SQL ships under `/app/drizzle`. `USER node`. **Cross-arch (Apple Silicon → linux/amd64) under QEMU is slow** — `fly deploy` (no `--local-only`) uses Fly's amd64-native remote builder.

---

## Feature log (one-liner per ship; detail in `constructions/` + git history)

### Removed
- **2026-05-15 — Paper bets removed.** Tables/use-cases/routes/job/FE handler all deleted in favour of on-chain bet pipeline. Migration `0044_parched_silvermane.sql`. **Follow-up**: re-add `place_bet` deep-link kind + handler when wiring real-money mini-app flow (`parseDeepLink` currently returns null since `place_bet` verb removed).
- **2026-05-08 — Tokenized stocks (Aster) removed.** Migration `0032_drop_stock_features.sql`. BSC chain (56) stays in `CHAIN_REGISTRY` (no current consumer). `signingRequest.cache.ts:planKind:"recovery"` discriminator remains wired but unused.

### Prediction markets (Polymarket pipeline)
- **2026-05-21 — One-click bet (Slice F follow-up: SigningResolutionEvent fan-out fix).** Ship-blocker discovered during ship-readiness audit: `signingRequest.usecase.resolveRequest`'s `onResolved` call wasn't forwarding `record.betId` / `record.setupForUserId` / `record.kind` / `record.purpose` / `params.polymarketOrderId` to the resolution event, so the BE wrapper in `assistant.di.ts:578` (`if (!event.betId && !event.setupForUserId) return;`) ALWAYS returned early at runtime — `notifySignResolved` / `notifySetupSignResolved` were never called. Bets enqueued sign requests fine but their state machine never advanced past whatever the FE just signed; the sweeper would loop re-enqueuing the same slot indefinitely. Fixed by (a) adding `setupForUserId?: string` to `SigningRequestRecord` (it was sneaking onto rows via `...args.link` spread in `commitEnqueue` but the type didn't declare it), (b) extending `SigningResolutionEvent` with `betId` / `setupForUserId` / `kind` / `purpose` / `polymarketOrderId`, and (c) threading those fields from `record` / `params` in `onResolved` fan-out. The 12 long-standing TS errors in `assistant.di.ts` clear with this fix. **`npx tsc --noEmit` is now fully clean.** Redis round-trip safe (cache uses full `JSON.stringify(record)`). Tests green.
- **2026-05-21 — One-click bet (Slice F, cutover).** Flag `PREDICTION_MARKETS_USE_SIGN_QUEUE` default flipped `false → true`. All `if (!this.useSignQueue)` guards inlined; the `useSignQueue` field is gone from `PredictionMarketBetUseCase`, capability constructors, and DI. Deprecated use-case methods deleted: `recordSetupStep`, `transitionBet`, `reportPriceDrift`, `recordRefundTxHash` (interface + impl + supporting imports). `SetupArtifact` and `SETUP_STEP_ORDER` removed. The legacy `?startapp=place_bet:` / `?startapp=close_position:` deep-link verbs no longer emit from the BE — `openMiniAppArtifact` always emits `?requestId=<id>` (or bare `MINI_APP_URL` when waiting on setup; the sweeper or next `advance()` provides the id). `polymarket_creds_enc` column write path was removed in Slice E-3; column itself drops in a follow-up migration after the 30-day deprecation window. `IPredictionMarketBetUseCase` now exposes setup-by-advance + intent + reconcile + finalize + close-by-advance. Rollback contract: setting the env back to `false` does not restore legacy behaviour — the legacy paths are deleted. 12 advance-tests + 83 total tests green; `npm run check:no-clob-secrets` green.
- **2026-05-21 — One-click bet (Slice E).** Route deletion + adapter trim + creds-write removal. **HTTP**: dropped the eight FE-callable bet/setup/order mutate routes (`POST /predictionMarket/setup/init|creds`, `POST /setup/:step`, `POST /order/place|sell`, `POST /order/cancel/:id`, `POST /bet/:id/transition|finalize|refund|drift-detected`, `GET /bet/:id/bridge-status`). Surviving HTTP surface is read-only: `state`, `intent/active`, `positions`, `intent/:id`, `intent/:id/cancel` (the only mutate left — cancels a chat-side intent before it executes), `bet/:id`, `orderbook/:tokenId`. The legacy use-case methods (`transitionBet`, `recordSetupStep`, `reportPriceDrift`, `recordRefundTxHash`) stay `@deprecated` on the interface — internal callers gone, deletion lands in Slice F. **Adapter**: `IPolymarketAdapter` renamed `IPolymarketReadAdapter`; dropped `deriveApiKey`, `placeOrder`, `cancelOrder` (the BE never POSTs to Polymarket anymore). `getOrderStatus` / `getPositions` keep L2 HMAC headers because those Polymarket endpoints require them — read-only invariant is enforced at the type level, not the URL level. **Use case**: `storePolymarketCreds` deleted; new sign-up flow flips `setupStep=authed` from `notifySetupSignResolved` on the `clob_auth` slot, never from a BE-side credential write. The `polymarket_creds_enc` column survives this slice (existing rows feed HMAC reads); follow-up migration drops it after 30 days. **CI gate**: `npm run check:no-clob-secrets` greps for `passphrase|deriveApiKey|POLY_API_KEY|POLY_PASSPHRASE|storePolymarketCreds|.placeOrder(|.sellOrder(` outside the read-only adapter + signing-request cache. Adapter `status.md` documents the read-only invariant. Slice F (flag flip + dual-path removal) still pending.
- **2026-05-20 — One-click bet (Slice D, flag-gated).** Capability rewiring + replay coverage for the queue-driven `/bet` + `/close` flows. `PlaceBetCapability` and `ClosePositionCapability` now accept a `useSignQueue` flag (DI-injected from `PREDICTION_MARKETS_ENV.useSignQueue`); when on, the chat→mini-app URL becomes `${MINI_APP_URL}?requestId=<firstEnqueuedSignId>` (the same `?requestId=` convention `/send` + `/swap` use). `IPredictionMarketBetUseCase.advance` / `setupAdvance` / `confirmBetIntent` / `initiateClose` now return `{ enqueuedRequestId }` so the capability can surface the id without an extra cache lookup. `enqueueOrderSign` drift branch: on `betKind='close'`, rolls the parent position back to `open` (`closingBetId=null`) and pushes a new `prediction_market_bet_drift` chat card via `PredictionMarketReceiptBroadcaster.emitDriftCard` — no new transport, just an additional verb. New replay tests cover close-happy, close-drift, close-partial, the setup→bet kickoff race, and the BetInFlight invariant across `betKind`. Flag stays **off** in prod; Slice E (route deletion + adapter trim) and Slice F (flag flip + dual-path removal) are tracked in `constructions/2026-05-20-one-click-bet-be.md`. New metadata fields in logs: `slot`, `enqueuedRequestId`, `betKind`.
- **2026-05-12 — Paper bets Parts 1–3.** REMOVED 2026-05-15.
- **2026-05-11 — Phase 5 LP sizing (Part 6).** `AnalyticalPredictionMarketSizer` for `subset`/`term_structure_anomaly`/`partition`. Verifier integration via `maybeSize`. New nullable columns on findings: `sized_trades jsonb`, `expected_profit_usdc_cents`, `min_payoff_usdc_cents`. Adapter `getOrderbookDepth({outcomeTokenId, side, depthLevels})`. Migration `0042_clean_ultron.sql`. Operator notes in invariants section above.
- **2026-05-11 — Phases 6–7 cutover runbook (Part 7).** Replay regression `predictionMarketsReplay.test.ts` over 3 frozen fixtures; routing invariant `pickDetector()`; hourly cron `check-extraction-review-queue`; weekly `weekly-shadow-summary`; PR template. Promotion checklist in invariants above.
- **2026-05-11 — Phase 4 deterministic detection (Part 5).** `deterministicPredictionMarketDetector.ts`. Routes on `cluster.expectedRelationships[0].kind`. Partition side stopgap = top-2-by-liquidity. Shadow mode → `prediction_market_findings_shadow`. Admin route `GET /admin/prediction-markets/shadow-agreement`. Diff script `diff-findings-vs-shadow.ts`. Migration `0041_blushing_gauntlet.sql`. Detector cfg: `tolBps = minGapBps`, `highConfidenceLiquidityUsd = findingMinLiquidityUsd × 4`, `highConfidenceMagnitudeBps = 500`.
- **2026-05-11 — Phase 3 deterministic clustering (Part 4).** `predictionMarketDeterministicCluster.usecase.ts` — buckets by `polymarketEventId` → `canonicalEventFamily`, drops incompatible `resolutionSource`s, picks `kind` mechanically (`gte`/`lte` at distinct thresholds → `nested`; `operator='in'` → `mutually_exclusive`; same op+threshold distinct `windowEnd` → `term_structure`; else `co_moving`). `MIN_CLUSTER_MEMBERS=3`. `derivedSubject` is **additive** — doesn't affect `clusterContentKey`/`hashClusterSet`/carry-forward. Migration `0040_handy_iceman.sql`. Diff `diff-clusters-vs-shadow.ts`.
- **2026-05-11 — Phase 2 extractor + review queue (shadow only).** `openaiPredictionMarketExtractor.ts` (default `gpt-4.1-mini`, strict JSON schema), `marketFactRegexVerifier.ts`, hourly redis-locked job (`pm:extract:lock`). Idempotent on `prediction_market_facts.market_id`. Admin TG review surface `pm_review:` callback prefix; **Edit not implemented** — operator approves/rejects or amends DB directly. Migration `0039_talented_ultimatum.sql`. Threshold stored as `n:<num>`/`s:<str>` tagged string.
- **2026-05-11 — Phase 1 foundation.** Ports `MarketFactTypes.ts` (`canonicalEventFamily()`), `marketFactVocabularies.ts` (`SUBJECTS`/`RESOLUTION_SOURCES`/`RESOLUTION_COMPATIBILITY`/`areResolutionSourcesCompatible`), `relationshipPrimitives.ts`. Pure definitions, no runtime callers. Coverage gate `scripts/measure-subject-distribution.ts` exits non-zero when named-subject coverage <85%.
- **2026-05-11 — Phase 0 role tags + directional verifier (`promptVersion v3`).** Detector emits four role tags as nullable-required JSON-schema fields. `promptVersion` `v2 → v3` invalidates detector Redis cache. Pre-Phase-0 nested rows flagged `missing-role-tag` (unrecoverable from prices); term-structure rows reconstruct from `resolution_epoch_sec`.
- **2026-05-07 — Stage 4 bet/close pipeline behind `_BETS_ENABLED=false`.** **READ FIRST before flipping flag** — 12-item open-work list in `constructions/2026-05-07-prediction-markets-stage4.md`. Ship-blockers: (1) bridge-initiation endpoint missing — `INITIATED → BRIDGING` has no BE call to start Avax→Polygon Relay quote; FE polls and dead-ends. (2) FE `pmApi.finalizePosition` POSTs `/predictionMarket/position/:id/finalize` which doesn't exist — drop FE call (BE `/bet/:id/finalize` already routes closes via `findPositionByClosingBetId`).
- **2026-05-07 — Stage 3 mispricing detection.** See invariants section.
- **2026-05-06 — Stage 1+2 scan.** See invariants section.

### Result-card / NL routing / yield / send/swap / platform — see invariants sections above
- **2026-05-05** — Sign-error diagnostics, auto-resume after Aegis-Guard reapproval, NL onto slash-command dispatcher, dynamic tool registry dropped.
- **2026-05-04** — Result-card framework, native via synthesis, native auto-sign, Ankr transfer history, auto-rebalance, yield bug-fix batch.
- **2026-05-03** — Self-derived recipient SCA.
- **2026-04-28** — Yield positions revamp (on-chain discovery + Messari subgraph; deposit/withdrawal tables dropped via `0026_stale_mandrill.sql`), delegation spend bookkeeping, recipient notifications, Ankr-backed portfolio.
- **2026-04-27** — Sign-resolution UX, `/swap`+`/yield` UX parity with `/send`, global `$ → USDC` normalization.
- **2026-04-25** — Loyalty Program (Season 0); `computePointsV1` idempotent on `intent_execution_id`. Cloud Run CI/CD + healthcheck + auth hardening (`POST /health` unauth, `ADMIN_PRIVY_DIDS` gate, ownership gate on `/permissions` + `/request/:id`).
- **2026-04-24** — Swap (Relay), yield optimizer (Aave v3), scaling (DB pool max 25, `MESSAGE_HISTORY_LIMIT=30`, OpenAI concurrency cap, DateTime out of system prompt to keep prefix-cache warm, Privy `verifyTokenLite` LRU, Redis `IPendingCollectionStore`, multi-replica safe session reads, Tavily + Relay quote cached, `ChainEntry.defaultRpcUrls: string[]` viem `fallback`), structured logging (all `console.*` migrated to pino).
- **2026-04-23** — Capability refactor (all TG flows through `ICapabilityDispatcher`, `handler.ts` ~200 LOC from 1146, `TriggerSpec.commands[]` multi-command, pending state JSON-safe). Onramp `/buy`.

## Backlog
- Proactive daily market sentiment → investment verdict agent.
- Aegis Guard agent-side enforcement: pre-UserOp re-check `limitRaw - spentRaw + validUntil`.
- `yield_hold_day` daily award (needs worker pass).
- Admin HTTP endpoint for `adjustPoints` (clawbacks).
- Cross-chain swap: destination-fill polling (`Relay /intents/status/v2`).
- Multi-stablecoin yield, partial withdrawal, additional yield adapters (Benqi/Yearn).
- Thread sender username through `CapabilityCtx.meta` so `recipient_notifications.senderHandle` is no longer always null.
