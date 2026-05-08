# Aegis Backend — Status

## What it is
Non-custodial, intent-based AI trading agent on Avalanche (and beyond). Hexagonal Architecture (Ports & Adapters) — use-cases depend only on interfaces; assembly lives in `src/adapters/inject/assistant.di.ts`. Users auth via Privy (Google or Telegram); Mini App passes `telegramChatId` to `POST /auth/privy`. Agent parses NL (incl. `$5` fiat shortcuts), classifies intent, compiles tool input schema, resolves fields, and executes via ERC-4337 UserOps through ZeroDev session keys. **Backend never signs transactions** — all signing via user delegated session keys in the mini-app.

> Capability-level details and recent feature notes live in `src/adapters/implementations/output/capabilities/status.md`. Read that file alongside this one before changing capability code. Result-card / error-catalog notes live in `src/helpers/errors/errorCatalog.md` and `src/helpers/errors/status.md`.

---

## 🚨 PRE-PRODUCTION SECURITY BLOCKERS — MUST FIX BEFORE MAINNET LAUNCH

> The items in this section were surfaced during a 2026-05-08 security review of
> the FE↔BE↔on-chain trust boundary. They are **listed in fix-priority order**.
> Each item is a real, exploitable hole that would put user funds at risk on
> mainnet at scale. Do not ship to production with any 🔴 unresolved.
> Cross-link: the FE-side log of the review lives at
> `fe/privy-auth/status.md` (entry "Web2-friendly UX wording revamp" has the
> security context that produced this list).

### 🔴 BLOCKER-1: Session keys are installed with `toSudoPolicy({})`, not a scoped policy

**Location**: `fe/privy-auth/src/utils/crypto.ts:162-167` (FE installs the
plugin; BE-side `delegation/grant` records are the only enforcement layer).
The comment in that file already acknowledges this: *"toSudoPolicy grants
full access — replace with toCallPolicy in production"*.

**What it means**: every session key currently installed on every user's
Kernel SCA can sign **any** UserOp targeting **any** contract for **any**
amount. The "spending limits" displayed in the UI ("Bot can use up to N
USDC") are enforced **only** by the BE refusing to push sign-requests over
the limit. There is **no on-chain backstop**.

**Why this is the dominant risk**:
- A BE compromise → attacker writes `sign_request` rows with `autoSign=true`
  and `(to, value, data)` of `usdc.transfer(attacker, bal)` for every user
  with an active delegation. On the next mini-app open, every user's FE
  signs and broadcasts. Whole user base drained, no key extraction needed.
- A supply-chain compromise (npm dep, CDN hijack) of the FE bundle exfils
  the encrypted blob + privyDid → offline decrypt → unrestricted SCA control
  per user.
- A single per-user TG account hijack gets the attacker into the mini-app
  as that user; the local key signs anything they want.

**Fix (BE side of the work)**:
1. Define the *exact* set of capabilities the bot needs:
   - ERC-20 `transfer` / `approve` to specific protocol addresses, with
     per-token `maxAmount` caps and time-windowed allowance budgets.
   - Specific swap router contracts + selector whitelist.
   - Specific yield protocol entry-points (Aave v3 `supply`/`withdraw`).
   - Polymarket EOA-side: see BLOCKER-3 — separate scope.
2. Express that set as a `toCallPolicy` (or `toMerkleCallPolicy`) policy
   when the FE calls `installSessionKey`. The FE patch is small; the BE
   work is enumerating + maintaining the policy spec (chain × protocol ×
   selector × amount cap), versioning it, and propagating new entries
   when capabilities are added.
3. Have the BE return the canonical policy spec to the FE on session-key
   install (not let the FE invent its own) so a malicious FE can't
   weaken the policy at install time.
4. Add an on-chain spending-cap validator alongside the call policy so
   "Bot can use up to N USDC" becomes a *real* on-chain bound, not a
   server-side policy. Without this the displayed cap is misleading.

**Acceptance**: install a session key with the new policy on Fuji; verify
that a UserOp signed by the session key targeting a non-whitelisted
contract reverts at the validator, not at the BE. Verify a `transfer`
above cap reverts on-chain. Document the policy schema in
`be/src/.../delegation/status.md`.

**2026-05-08 — scoped partial fix (BE side, amount cap only).**
Per product decision, BLOCKER-1 is being narrowed to **on-chain amount cap
only** — no contract whitelist, no selector whitelist, no native-value
restriction. Single change: at session-key install the FE replaces
`toSudoPolicy({})` with `toSpendingLimitPolicy(limits)` seeded from the
user's `tokenDelegation` rows. New BE endpoint added:

- `GET /delegation/spending-limits?chainId=…` →
  `{ chainId, limits: [{ token, cap, validUntil }] }` — sourced from
  `tokenDelegationRepo.findActiveByUserId`. Same rows that drive
  `aegisGuardInterceptor`, so on-chain cap and BE preflight share one
  source of truth. No new schema, no signing, no policy versioning.

Residual risk explicitly accepted (do not file as regressions):
- Session key can still call any contract; only token *amount* movement
  is bounded.
- On-chain `cap` is fixed at install time. Top-ups via the existing
  `aegis_guard` `ApproveRequest` flow update `tokenDelegation.limitRaw`
  in the BE only — the on-chain validator continues to enforce the
  original cap. Once on-chain `spent == cap`, that token is frozen for
  the session key until the key is re-installed (Privy owner sig).
- Native value transfers and unlisted-token transfers are not bounded
  on-chain.

FE patch (`fe/privy-auth/src/utils/crypto.ts:166`) tracked separately.

---

### 🔴 BLOCKER-2: Encryption password for the session-key blob is `privyDid` (an identifier, not a secret)

**Location**: `fe/privy-auth/src/hooks/useDelegatedKey.ts` and
`fe/privy-auth/src/utils/sessionEoa.ts:24` —
`decryptBlob(encrypted, privyDid)`. Crypto primitives are sound (AES-GCM-256
+ PBKDF2 100k iterations + random salt+IV); the **password choice** is the
hole.

**What it means**: `privyDid` is a stable user identifier emitted by Privy
on every authenticated session. It's the kind of value that routinely
appears in:
- BE access logs
- Sentry / Datadog / observability traces
- Analytics events keyed on `userId`
- Error reports from FE → BE
- Anywhere the user is referenced in code

It is **not** a high-entropy secret. Anyone who obtains both (a) the
encrypted blob (sitting in the user's TG CloudStorage) and (b) the
privyDid (from any of the above logs) can decrypt the privkey offline.
Combined with BLOCKER-1, that's a full SCA drain per leaked user.

**Fix (BE side of the work)**:
1. Audit every BE log/observability sink for `privyDid` references and
   either redact or hash them with a non-reversible HMAC keyed on a
   secret. Treat `privyDid` as PII-tier: never log raw, never index on
   it externally.
2. Replace the encryption-password derivation with something that's
   actually a secret. Two viable approaches:
   - **Server-released secret**: BE holds a per-user random key (HSM /
     KMS), released to the FE only after Privy re-auth. FE uses
     `serverSecret || optionally a user-set passcode` as the PBKDF2
     input. Loses the "open and go" UX (one extra Privy popup per
     session), but the password becomes a real secret.
   - **WebAuthn / passkey-bound key**: derive the encryption key from a
     passkey signature. No server side, but requires the user to have a
     passkey provider.
3. Whichever approach: rotate every existing user's blob on next open
   (decrypt with old privyDid, re-encrypt with new password) and wipe
   the old blob. Document the migration plan.

**Acceptance**: search the codebase + observability config for any path
that emits raw `privyDid`; CI gate that adds `eslint`/grep rule to fail on
new occurrences. Verify a fresh blob can't be decrypted with just a
known privyDid.

---

### 🔴 BLOCKER-3: `maxUint256` ERC-20 / `setApprovalForAll(true)` to Polymarket contracts

**Location**: `fe/privy-auth/src/components/handlers/PlaceBetHandler.tsx:184-200`.
During Polymarket setup the session-key EOA approves:
- `usdc.approve(ctfExchange, maxUint256)`
- `usdc.approve(negRiskExchange, maxUint256)`
- `ctf.setApprovalForAll(ctfExchange, true)`

**What it means**: Polymarket uses `signatureType=EOA`, so these standing
approvals live on the **session-key EOA's** Polygon address (not the SCA).
If the privkey leaks (via BLOCKER-1 or BLOCKER-2 paths), an attacker doesn't
need to bridge anything — they can sign Polymarket orders that drain whatever
USDC has been bridged to that EOA, and they can transfer outcome tokens
freely. A separate SCA-side hardening doesn't help here because Polymarket
signs against the EOA.

**Fix (FE-led, BE coordinates)**:
1. Switch to **per-bet exact-amount approvals**: approve `stakeUsdc` (not
   `maxUint256`) right before each `placeOrder` call, and reset to 0 after
   the bet finalizes. Eats one extra UserOp per bet (paymaster cost) but
   removes the standing-approval risk.
2. OR: introduce a Polymarket middleware contract owned by the SCA that
   forwards orders into CTFExchange, with an internal spending budget the
   user can rate-limit.
3. Add a job that periodically reads on-chain allowances for every active
   user and emits a metric/alert if any non-zero standing approval exists
   outside an active bet window.

**Acceptance**: after a Polymarket bet completes (or fails), the on-chain
USDC allowance from the session-key EOA to both exchange contracts is `0`.
`setApprovalForAll` either is removed via `setApprovalForAll(false)` after
the position closes, or is replaced with a scoped per-position approval
mechanism.

---

### 🟠 BLOCKER-4: Auto-sign trusts BE-supplied tx data without on-chain or client-side validation

**Location**: `fe/privy-auth/src/components/handlers/SignHandler.tsx`
auto-sign branch — when a sign-request arrives with `autoSign: true` the
FE immediately builds and signs the UserOp using `(request.to,
request.value, request.data)` with no decode, no comparison against an
expected protocol whitelist, no human confirmation.

**What it means**: this is the *vector* through which BLOCKER-1 is
exploitable at scale. Even after BLOCKER-1 is closed (scoped on-chain
policy), this remains the attack surface for "drain whatever the policy
allows" (e.g., spend the USDC cap, even if to the wrong recipient). It's
also the surface for prompt-injection attacks if the LLM ever has direct
authority to enqueue sign-requests.

**Fix (BE side)**:
1. Sign every outbound `sign_request` row with a BE-side key whose
   pubkey is pinned in the FE bundle, and have the FE verify the sig
   before signing. Closes the gap where a DB-only compromise (write
   access to `sign_requests`) yields drains.
2. For every sign-request, the BE also writes the **decoded intent**
   (function name, args, target, target's role in the protocol, expected
   amount, expected counterparty) into a separate field. The FE decodes
   `request.data` independently and refuses to sign if it doesn't match
   the BE's stated intent byte-for-byte. Asymmetric trust: both halves
   must agree.
3. For high-value or unusual requests, force a manual confirm modal
   regardless of `autoSign`. Define "high-value" as: (a) amount above
   N% of remaining cap, (b) target not on the protocol whitelist, (c)
   selector not previously seen for this user, or (d) chain not
   recently used.
4. Rate-limit how many auto-sign requests a single user can be issued
   per N minutes; alert if exceeded.

**Acceptance**: fuzz the BE→FE sign-request channel with a forged row
(no BE signature, mismatched decoded intent) and confirm the FE rejects
both. Confirm a normal flow (chat → tool → sign-request) still works.

---

### 🟠 BLOCKER-5: Disconnect doesn't revoke on-chain or BE-side authority

**Location**: `fe/privy-auth/src/hooks/useDelegatedKey.ts:329` —
`removeKey()` only wipes the local Telegram CloudStorage blob and clears
in-memory state. There is no:
- BE call to delete the `delegation/grant` row
- On-chain UserOp to uninstall the Kernel permission plugin / session-key
  validator
- Reset of standing ERC-20 / CTF approvals (BLOCKER-3)

**What it means**: in practice Disconnect *is* effective today because the
privkey is gone and only the user holds it (so no actor can exercise the
permission). But that depends on the privkey having been in only one
place. Once BLOCKER-2 is fixed it'll still depend on the password not
having leaked. We shouldn't ship a "Disconnect" affordance whose label
implies revocation while delivering only key deletion.

**Fix (BE side)**:
1. Implement `DELETE /delegation/grant` (or equivalent) that removes the
   BE-side grant rows.
2. Implement an FE flow that, on Disconnect, asks the user to sign a
   single sudo UserOp (Privy popup) that uninstalls the session-key
   plugin and zeros out residual approvals, before wiping CloudStorage.
3. UX clarification: keep the "Disconnect" button but rename to "Revoke
   bot access" with copy that explains both halves are happening, and
   show a progress indicator while the on-chain revoke confirms.
4. Job that proactively expires + revokes session keys past their
   `validUntil` even if the user never logs back in.

**Acceptance**: after Revoke, querying the SCA on-chain shows the
session-key plugin is no longer installed; `delegation/grant` returns
empty for that user; standing approvals on every chain are 0.

---

### 🟡 BLOCKER-6: FE supply-chain hardening is absent

**Location**: `fe/privy-auth/package.json`, `vite.config.ts`,
`index.html`. No subresource integrity on bundled assets, no strict CSP
header on the served HTML, no lockfile-hash gate in CI, no `npm audit`
gate, no dependency pinning by integrity hash.

**What it means**: the FE bundle is one compromised npm dep away from
exfilling every user's encrypted blob + privyDid (= every user's privkey,
once BLOCKER-2 is mitigated only partially). At the scale this app would
hit on mainnet, this is a when-not-if.

**Fix (BE side: serve hardening)**:
1. Add a strict Content-Security-Policy header from whatever serves the
   FE bundle (Fly proxy / nginx). Allow only the specific origins the
   mini-app talks to: backend API host, Privy auth host, Telegram WebApp
   host, RPC/bundler/paymaster hosts, the CLOB API host. Disallow inline
   scripts, eval, blob: workers, etc. Test with the mini-app actually
   running.
2. Add SRI hashes on any externally-loaded asset. Ideally bundle
   everything internally so there are no external loads.
3. CI gate: lockfile must verify, `npm audit --audit-level=moderate`
   must pass, deps must be pinned (no `^` ranges) — or at least the
   ones that touch crypto / wallet / RPC code.
4. Sentry / observability: alert on FE→unknown-origin network calls in
   production builds (any POST to a domain not on the allowlist).

**Acceptance**: CSP report-only mode in staging confirms no in-app feature
trips the policy; flip to enforcing in prod. CI fails if a dep with a
known critical CVE is added.

---

### 🟡 BLOCKER-7: BE has no rate-limit / anomaly detection on `sign_request` writes

**What it means**: even with all the above, an attacker who gets DB write
or BE-RCE could write 100k sign-requests in seconds. There is no
"this is unusual, hold for review" gate.

**Fix (BE side)**:
1. Per-user rate limit on outbound sign-requests (e.g., max 5 per minute,
   max 50 per hour). Configurable per capability.
2. Anomaly detector that flags batched writes affecting many users
   within a short window (the BLOCKER-1 attack signature). Pause auto-
   delivery and require ops sign-off when tripped.
3. Audit log table that records every sign-request write with the
   originating use-case, requestId, and a hash of the intent — so post-
   incident forensics is possible.

**Acceptance**: load-test confirms the rate limit doesn't break normal
UX; simulated mass-attack writes trip the anomaly detector and block
delivery.

---

### Severity legend
- 🔴 Hard blocker — exploitable at mass scale today; do not ship to mainnet.
- 🟠 Strong blocker — exploitable with one extra step or per-user.
  Ship-blocking unless explicitly accepted with mitigations.
- 🟡 Should-fix before launch — meaningfully reduces blast radius even if
  the others remain. Cheap to do; do them.

### Why these are listed in this file (not split by component)
The vulnerabilities cross the FE/BE/on-chain boundary; ownership is
shared. Listing them in one prominent place under the BE STATUS — which
is the file engineers consult before any pre-prod change — guarantees
they're seen as gating before launch. As each is addressed, move it from
this section to a "Resolved security blockers" appendix at the bottom of
this file with a brief note on what shipped and the commit/PR.

---

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
| Prediction markets | Polymarket Gamma (universe scan) + Polymarket CLOB (orderbook + signed-order forwarding). User Polygon SCA (Kernel v3.1, derived). Cross-chain stake bridged Avax→Polygon via Relay. |
| Deployment | Fly.io (`aegis-core`, region `iad`) + Neon Postgres + Upstash Redis |

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
13. **Terminal capability outcomes are `result_card`, never `chat`.** `kind: "chat"` is reserved for intermediate ask/disambiguation prompts. Capabilities never write MarkdownV2 — they hand the renderer plain strings via `IntentResult` and `escapeMd` runs in `resultCard.render.ts`. Caught exceptions go through `interpretError(err, { verb, requestId })` from `helpers/errors/errorCatalog.ts` — never inline raw error strings into user-visible fields.
14. **Sign-request previews go through `buildPreview`.** Capabilities emitting `sign_calldata` for an ERC-20 / native spend MUST set `preview: buildPreview({...})` so the mini-app modal shows a clean human summary instead of raw calldata. For multi-step flows, the preview attaches to the FIRST step's record only (subsequent records leave `preview` undefined; FE chains silently). Use the `executeSignSteps({ previews })` array variant only when distinct per-step modal labels are required.

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
│   └── interface/{input,output}/          # input ports include resultCard.types (IntentResult,
│                                          # IntentVerb, ResultStatus, ResultField, ResultAction)
│                                          # — the canonical capability-outcome shape.
│                                          # output subdirs: blockchain (IChainReader,
│                                          # IBalanceProvider, ITransferHistoryProvider), cache,
│                                          # delegation, repository (17 repos), yield (6 sub-ports),
│                                          # solver, embedding, intentParser, intentInterpreter,
│                                          # artifactRenderer, orchestrator, resolver, schemaCompiler,
│                                          # toolIndex, vectorDB, predictionMarket (provider/
│                                          # classifier/detector/verifier/repo/broadcaster/
│                                          # findingBroadcaster/receiptBroadcaster/polymarketAdapter/
│                                          # betUseCase/betRepository), etc.
├── adapters/
│   ├── inject/assistant.di.ts             # Lazy-singleton wiring
│   └── implementations/
│       ├── input/
│       │   ├── http/httpServer.ts         # exactRoutes + paramRoutes
│       │   ├── jobs/                      # tokenCrawler, yieldPoolScan, userIdleScan, yieldReport,
│       │   │                              # predictionMarketScan, polymarketPositionPoller
│       │   └── telegram/                  # bot.ts, handler.ts (~200 LOC; cmd:<text> callback relay)
│       └── output/                        # balance (ankr/rpc/cached 30s), transferHistory
│                                          # (ankr/cached rate-guarded), capabilities (buy/send/swap/
│                                          # yield/loyalty/assistantChat/placeBet/closePosition +
│                                          # buildPreview + assistantResultRouter),
│                                          # artifactRenderer (telegram + resultCard.render +
│                                          # resultCard.escape — single MarkdownV2 entry point),
│                                          # intentInterpreter (openai adapter, env-gated, ≤25w),
│                                          # yield (aaveV3Adapter, subgraphPrincipalProvider,
│                                          # onChainPositionDiscovery), predictionMarket
│                                          # (polymarketAdapter, polymarketProvider,
│                                          # predictionMarketClassifier/Detector/Verifier,
│                                          # broadcaster + findingBroadcaster + receiptBroadcaster),
│                                          # tools (system + read-only agent tools incl.
│                                          # getPortfolio / getTransferHistory / routeIntent;
│                                          # each returns `{success,data,structured?}`),
│                                          # openai, viemClient, resolverEngine, pinecone,
│                                          # redis caches, relay, etc.
└── helpers/
    ├── chainConfig.ts                     # CHAIN_REGISTRY/CONFIG; getViemChain, getRpcUrlForChain,
    │                                      # getNativeTokenInfo, NATIVE_PSEUDO_ADDRESS, isNativeAddress
    ├── aaConfig.ts                        # AA stack constants — lockstep with FE
    ├── deriveScaAddress.ts                # Counterfactual SCA derivation (1h LRU)
    ├── notifyResolved.ts                  # Shared sign-resolution Telegram notification
    ├── decodeErc20Transfer.ts             # transfer(address,uint256) calldata decoder
    ├── observability/                     # logger.ts (pino), metricsRegistry.ts
    ├── enums/                             # All enums (executionStatus, intentAction, intentCommand, …)
    ├── crypto/aesGcm.ts                   # AES-256-GCM (versioned envelope `v1:iv:tag:ct`)
    ├── env/                               # Per-feature env readers (assistantEnv, loyaltyEnv,
    │                                      # openaiEnv, predictionMarketEnv, resultCardEnv,
    │                                      # telegramEnv, transferHistoryEnv, yieldEnv, role)
    ├── errors/                            # errorCatalog (PATTERNS + interpretError + ErrorCode),
    │                                      # RateLimitedError, UnsupportedChainError, toErrorMessage
    ├── format/humanFormat.ts              # formatTokenAmount/Usd/RelativeTime/Duration, truncateHash
    └── …                                  # bigint, uuid, cache, concurrency, time, loyalty
```

## Contract Registry
Default chain: Avalanche C-Chain mainnet (43114). `CHAIN_ID=43113` → Fuji.
- AegisToken (Proxy, Fuji): `0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69`
- RewardController (Proxy, Fuji): `0x519092C2185E4209B43d3ea40cC34D39978073A7`
- Reward-controller address per-deploy via `REWARD_CONTROLLER_ADDRESS` env.
- Avalanche USDC aToken: `0x625E7708f30cA75bfd92586e17077590C60eb4cD`.
- Aave V3 subgraph (Messari): deployment `72Cez54APnySAn6h8MswzYkwaL9KjvuuKnKArnPJ8yxb`.
- Polymarket CTF Exchange (Polygon 137): `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`; NegRisk variant: `0xC5d563A36AE78145C45a50134d48A1215220f80a`. Conditional Tokens Framework + NegRisk Adapter live at the addresses recorded in `chainConfig.ts:CHAIN_REGISTRY[137].polymarket` — read via `getPolymarketConfig(chainId)`. Never inline.

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
| `GET` | `/delegation/approval-params?chainId=137` | Privy | Optional `chainId` query param routes the suggested-tokens response to a specific chain. Omitted → home chain. |
| `*` | `/predictionMarket/*` | Privy | 12 routes covering setup state machine (`setup/init`, `setup/step`, `setup/creds`), bet intent lifecycle (`intent/:id`, `intent/:id/cancel`), bet execution (`bet/:id`, `bet/:id/transition`, `bet/:id/finalize`, `bet/:id/bridge-status`, `bet/:id/drift-detected`, `bet/:id/refund`), Polymarket orderbook + order place/cancel/sell, position list, and `/state` snapshot for mini-app rehydration. 409 on illegal bet-status transitions; 503 when `PREDICTION_MARKETS_BETS_ENABLED=false`. |

## Telegram commands
| Command | Behavior |
|---|---|
| `/start`, `/auth`, `/logout`, `/new`, `/history`, `/confirm`, `/cancel`, `/portfolio`, `/wallet`, `/sign` | Auth + meta |
| `/buy <amount>` | BuyCapability — onramp keyboard (copy SCA address or MoonPay mini-app). |
| `/send`, `/money`, `/convert`, `/topup`, `/dca`, `/sell` | SendCapability — compile→resolve→Aegis Guard→sign (native + ERC-20 both auto-sign) |
| `/swap` | SwapCapability — Relay cross/same-chain |
| `/yield`, `/withdraw` | YieldCapability — Aave v3 deposit/withdraw. Also handles `rebalance:y/n` callbacks emitted by the per-user rebalance scan (sticky-winner protocol switch via `withdrawAll(old) → supply(new)` in one mini-app session). |
| `/points`, `/leaderboard` | LoyaltyCapability |
| _(callback `place_bet:findingId:marketId:A\|B`)_ | PlaceBetCapability — confirm-amount card → write bet row → deep-link to mini-app. Cross-chain stake bridged Avax→Polygon, then EOA-signed Polymarket order. Receipt cards (`bet_placed`/`bet_failed`) pushed by `PredictionMarketReceiptBroadcaster`. Gated on `PREDICTION_MARKETS_BETS_ENABLED=true`. |
| _(callback `close_position:positionId`)_ | ClosePositionCapability — re-quote on confirm-tap (drift-aware), open close bet, sell-side Polymarket order. `position_closed` / `position_resolved` cards pushed by the receipt broadcaster + `PolymarketPositionPollerJob`. |
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
| `loyalty_seasons`, `loyalty_action_types`, `loyalty_points_ledger` | Loyalty program. Canonical action types: `swap_same_chain`, `swap_cross_chain`, `send_erc20`, `send_native`, `yield_deposit`, `yield_hold_day` (deferred), `referral`, `manual_adjust`. |
| `recipient_notifications` | P2P send recipient notifications (pending/delivered/failed) |
| `prediction_market_runs` | One row per scan tick. `universeHash`, `clusterSetHash`, `status` (`fetched`/`clustered`/`published`/`failed`), `is_latest` flag (atomically flipped per run via `setLatestRun` transaction). |
| `prediction_market_snapshots` | Top-100 markets surviving filters per run. Money fields stored as **cents** (`bigint`); prices as **basis points** (`integer 0..10000`). PK `(run_id, market_id)`. |
| `prediction_market_clusters` | LLM-derived causal clusters (≥3 marketIds) per run. `marketIds` + `expectedRelationships` JSONB. **Carry-forward** runs (no recluster) preserve the prior run's `cluster_id` so stage-3 detector cache and `prediction_market_findings.cluster_id` correlate across runs. |
| `prediction_market_findings` | Stage-3 verified mispricing findings. `cluster_id` is stable across runs (analytical: "how often did cluster X surface a finding?"). `magnitude_bps` + `rank_score` (×1000 to fit `integer`) drive broadcast ordering. `broadcasted_at_epoch` set after the per-finding fan-out completes. Indexed by `run_id`, `cluster_id`, `created_at_epoch`. |

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
| `yield:winner_streak:{chainId}:{token}` | `4 × poolScanIntervalMs` | `{ protocolId, apy, count, lastTs }` — sticky-winner hysteresis for auto-rebalance |
| `yield:rebalance_cooldown:{userId}` | `YIELD_REBALANCE_NUDGE_COOLDOWN_SEC` (24h) | `"1"` — per-user rebalance nudge cooldown |
| `yield:rebalance_pending:{userId}` | 1h | `"1"` — rebalance consent outstanding / in-flight |
| `loyalty:season:active` | 60s | active season JSON |
| `loyalty:leaderboard:{seasonId}:{limit}` | 30s | leaderboard JSON |
| `pm:scan:lock` | `0.9 × PREDICTION_MARKETS_FETCH_INTERVAL_MS` | per-tick scan lock (`SET NX PX`); released on completion if still owned |
| `pm-cluster:{promptVersion}:{model}:{sha256(sortedMarketIds@resolutionEpochs)}` | `PREDICTION_MARKETS_CLUSTER_CACHE_TTL_SEC` (24h) | cached `DraftCluster[]` from the LLM |
| `pm:broadcast:lastHash:{userId}` | 7d | last `clusterSetHash` delivered — dedupe per user |
| `pm-detect:{sha256(clusterId + sortedMembers@bucketedYesPriceBp + promptVersion + model)}` | `PREDICTION_MARKETS_DETECTOR_CACHE_TTL_SEC` (1800s) | cached `DraftFinding[]` for stage-3 LLM. Member YES prices are bucketed to `PREDICTION_MARKETS_DETECTOR_PRICE_BUCKET_BPS` (default 50bp) so flat ticks hit, real movement misses. Verifier still runs against fresh prices. |
| `pm:finding:lastSeen:{userId}:{findingId}` | 7d | per-user dedupe so a re-broadcast for the same `findingId` doesn't double-send. Cross-run dedupe is intentionally NOT applied (each new `findingId` fans out once). |

## Key environment variables
| Variable(s) | Default | Purpose |
|---|---|---|
| `DATABASE_URL` / `DB_POOL_MAX` | `postgres://localhost/aether_intent` / `25` | Postgres. Pool budget: replicas × 25 + 1 ≤ max_connections |
| `REDIS_URL` | — | Redis (optional; adapters fall back to in-memory) |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_CONCURRENCY` | — / `gpt-4o` / `6` | LLM + embeddings; per-replica p-limit cap |
| `TELEGRAM_BOT_TOKEN`, `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` | — | Telegram + MTProto |
| `HTTP_API_PORT`, `MINI_APP_URL` | `4000` / — | (Fly maps `internal_port = 4000` in `fly.toml`) |
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
| `YIELD_REBALANCE_CHECK_INTERVAL_MS`, `YIELD_REBALANCE_MIN_DELTA_BPS`, `YIELD_REBALANCE_STICKY_SCANS`, `YIELD_REBALANCE_NUDGE_COOLDOWN_SEC` | `86400000` / `50` / `3` / `86400` | Auto-rebalance: per-user scan cadence, min APY uplift in bps, consecutive winning scans before nudging, per-user nudge cooldown |
| `YIELD_REPORT_UTC_HOUR`, `YIELD_REPORT_INTERVAL_MS` | `9` / unset | Daily report UTC hour. When `INTERVAL_MS>0`, run at that interval and skip the daily gate (debug/QA). |
| `LOYALTY_ACTIVE_SEASON_CACHE_TTL_MS`, `LOYALTY_LEADERBOARD_CACHE_TTL_MS` | `60000` / `30000` | |
| `PREDICTION_MARKETS_ENABLED`, `PREDICTION_MARKETS_FETCH_INTERVAL_MS`, `PREDICTION_MARKETS_GAMMA_API`, `PREDICTION_MARKETS_MAX_FETCH_PAGES`, `PREDICTION_MARKETS_TOP_N` | `false` / `1800000` (30 min) / `https://gamma-api.polymarket.com` / `4` / `100` | Daily prediction-market scan job toggle + Polymarket fetch cadence/page bounds. `enabled=false` keeps the job idle (no Polymarket calls). |
| `PREDICTION_MARKETS_MIN_OI_USD`, `PREDICTION_MARKETS_MIN_7D_VOLUME_USD`, `PREDICTION_MARKETS_MIN_DAYS`, `PREDICTION_MARKETS_MAX_DAYS` | `50000` / `20000` / `3` / `60` | Stage-1 filter set. Markets surviving all four (plus binary YES/NO + non-empty resolution criteria + `acceptingOrders=true`) are ranked by liquidity and capped to `TOP_N`. |
| `PREDICTION_MARKETS_CLASSIFIER_MODEL`, `PREDICTION_MARKETS_MAX_CRITERIA_CHARS`, `PREDICTION_MARKETS_PROMPT_VERSION`, `PREDICTION_MARKETS_CLUSTER_CACHE_TTL_SEC` | `gpt-4o` / `4000` / `v1` / `86400` | Stage-2 LLM classifier (structured outputs, JSON-schema strict). Cache key includes `promptVersion + model + sha256(sortedMarketIds@resolutionEpochs)`. |
| `PREDICTION_MARKETS_RECLUSTER_DELTA`, `PREDICTION_MARKETS_MAX_RECLUSTER_AGE_MS` | `10` / `86400000` (24h) | Stage-2 trigger predicate: re-cluster when universe hash changes, OR > delta markets churn between snapshots, OR last clustering older than max age. |
| `PREDICTION_MARKETS_BROADCAST_CONCURRENCY` | `5` | Per-tick `pLimit` for the Telegram fan-out. |
| `PREDICTION_MARKETS_FINDINGS_ENABLED` | `false` | Stage-3 dark-launch switch. Read once at the orchestration call site (`PredictionMarketScanUseCase.runOnce`) — when `false`, stages 1-2 keep running and the entire detect → verify → broadcast block is skipped. Independent of `PREDICTION_MARKETS_ENABLED`. |
| `PREDICTION_MARKETS_DETECTOR_MODEL`, `PREDICTION_MARKETS_DETECTOR_CONCURRENCY`, `PREDICTION_MARKETS_DETECTOR_CACHE_TTL_SEC`, `PREDICTION_MARKETS_DETECTOR_PRICE_BUCKET_BPS` | `${classifierModel}` / `3` / `1800` / `50` | Stage-3 detector LLM: model (defaults to classifier model), per-tick `pLimit` for parallel cluster detection, Redis cache TTL, and YES-price bucket size for cache key (smaller = more cache misses, fresher LLM output). |
| `PREDICTION_MARKETS_VERIFY_FRESHNESS_MS`, `PREDICTION_MARKETS_ODDS_DRIFT_TOLERANCE_BPS`, `PREDICTION_MARKETS_MIN_GAP_BPS`, `PREDICTION_MARKETS_FINDING_MIN_LIQUIDITY_USD` | `60000` / `50` / `100` / `25000` | Stage-3 verifier gates: live-quote in-memory cache TTL, max allowed drift between LLM-cited odds and live odds before drop, minimum gap (bps) for numeric patterns (term-structure / movement / logical), and minimum per-market liquidity floor for tradeable findings. |
| `PREDICTION_MARKETS_POLYMARKET_AFFILIATE` | `""` | Optional affiliate query-string param appended to Polymarket URL buttons (`?affiliate=…`). Empty = no param. |
| `RESULT_CARD_INTERPRETER_ENABLED`, `RESULT_CARD_INTERPRETER_MODEL` | `false` / `RESULT_CARD_INTERPRETER_MODEL ?? OPENAI_MODEL ?? gpt-4o-mini` | Result-card LLM interpreter. Env-gated and AND-ed with `OPENAI_API_KEY`. Only fires when `complexity === "complex"`. 2s timeout, ≤25-word output, optional Redis cache (`interp:` namespace, 5-min TTL). All reads go through `helpers/env/resultCardEnv.ts:getResultCardEnv()` — never inline `process.env.RESULT_CARD_*`. |

## Coding conventions
- **IDs**: `newUuid()` only (UUID v4). **Timestamps**: `newCurrentUTCEpoch()` (seconds). Columns end in `AtEpoch`.
- **Config**: every `process.env.X` hoisted to top-of-file `const`. Chain values in `chainConfig.ts` only.
- **Enums**: prefer `helpers/enums/` values over inline strings. `parseIntentCommand` is the only slash matcher.
- **Hexagonal**: `MiniAppRequest`/`DelegationRecord` live under `interface/output/cache/` — no cross-layer leakage.
- **DB facade**: single `DrizzleSqlDB`; repos hang off as `db.users`, `db.toolManifests`, etc. Use-cases receive the repo interface, never the facade.
- **Lazy singletons** in `AssistantInject`: `if (!this._x) this._x = new X(...)`. Optional-env services return `undefined` when unconfigured.
- **HTTP routing**: `exactRoutes` or `paramRoutes` only. Never if/else chains.
- **Encrypted secrets**: `helpers/crypto/aesGcm.ts` (versioned envelope `v1:iv:tag:ciphertext`). Used for at-rest Polymarket L2 creds in `prediction_market_user_setup.polymarket_creds_enc`. Future rotations append `v2:` rather than mutating in place.
- **Logging**: pino via `createLogger('ScopeName')`. Metadata is first arg. Never `console.*` in `src/`. Never log tokens, privyDid, signatures, raw PII. Common metadata fields: `step`, `reqId`/`userId`, `err`, `durationMs`, `status`, `attempt`, `choice` (cache hit/miss), `count`, `source: "db"|"derived"`, `stale: boolean`.
- **Free-tier external providers**: wrap adapter in a `CachedXxxProvider(inner, cache, userId, cfg)` decorator using `acquireUserSlot(userId, rpm)` + `acquireGlobalSlot(rps)`. Never inline rate-limit logic into adapters. Use the generic `RateLimitedError` / `UnsupportedChainError` (HTTP layer maps to 429/400; tools surface graceful retry messages).
- **Spend bookkeeping**: capabilities emitting autosign signing-requests for ERC20 spends MUST set `tokenAddress` (lowercased) + `amountRaw` (decimal raw string) on the `SigningRequestRecord` / `sign_calldata` artifact of the **single tx that actually moves the user's funds** — typically the last step. Native paths leave both undefined. `signingRequest.usecase.resolveRequest` calls `tokenDelegationDB.addSpent(userId, tokenAddress, amountRaw)` best-effort.
- **Multi-step capabilities**: emit `mini_app` for step 1 only; store steps 2..N via `miniAppRequestCache.store(...)`; FE chains via `GET /request/:id?after=<prev>`. One mini-app session per intent.
- **Fiat normalization**: `OpenAISchemaCompiler.compile()` runs `normalizeFiatAmount(text)` before LLM — `$N`/`N dollars/bucks/usd` → `N USDC`. New capabilities inherit this; don't re-implement `detectStablecoinIntent`.
- **Recipient resolution**: `eoa → DB profile.smartAccountAddress` if onboarded, else `deriveScaAddress(eoa, chainId)`. DB row always wins over derivation.
- **Soft-fail capability boot**: capabilities that depend on external invariants (e.g. on-chain ABI struct verification, optional `PREDICTION_MARKETS_BETS_ENABLED` flag) expose an `async verifyXCapability()` (or DI getter that returns `undefined`) on `AssistantInject` that swallows errors and flips a `_xCapabilityDisabled` flag. CLIs `await` it after instantiation; the rest of the backend keeps booting. HTTP routes guard via `isXCapabilityDisabled()` and return `503 { error: "x_unavailable" }`. Mirror this for any new chain-bound capability.
- **Per-step `chainId` on cross-chain plans**: each step in a multi-step plan carries its own `chainId` so a single mini-app session can sequence home-chain bridge legs (e.g. Avax SCA → Polygon SCA via Relay) and venue-chain action legs together. The FE's chained `?after=<prevId>` poll picks each up with its own chainId. Pattern lives in the prediction-market bet pipeline (`predictionMarketBetUseCase`).
- **`spendTokenAddress` only on the LAST home-chain leg** of multi-step cross-chain plans (mirrors `swapCapability`). Tagging a venue-chain leg attributes spend against a delegation row that doesn't exist for the venue-chain token.
- **Bet-state transitions are repo-enforced.** `IPredictionMarketBetRepository.updateBetStatus` does a `SELECT … FOR UPDATE` inside a txn and validates the move against the `BET_STATE_TRANSITIONS` map; illegal transitions throw `IllegalBetTransitionError` → HTTP 409. Never silently absorb it. Setup-step transitions are linear-monotonic (forward-by-≤1 or same).

## Extension patterns
- **New system tool**: `ITool` → add to `SystemToolProviderConcrete.getTools()`.
- **New DB table**: `schema.ts` → repo interface → Drizzle impl → `DrizzleSqlDB` → DI → `db:generate && db:migrate`.
- **New solver**: `ISolver` in `output/solver/` → register under correct `INTENT_ACTION`.
- **New HTTP route**: `exactRoutes` or `paramRoutes`. Signature: `(req, res, url, ...params) => Promise<void>`.
- **New Capability**: implement `Capability`, register in `AssistantInject.getCapabilityDispatcher()`. Reserve unique `triggers.callbackPrefix`.
- **New sign-error code**: add to FE `interpretSignError.ts` AND BE `notifyResolved.ts` recovery branch. String is the contract.
- **New chain**: one `CHAIN_REGISTRY` entry in `chainConfig.ts`; set `ankrBlockchain` if Ankr supports it. Native token is auto-synthesized from viem's `Chain.nativeCurrency`.
- **New external provider port**: define `IXxxProvider` under `interface/output/blockchain` (or appropriate subdir). Implement `CachedXxxProvider` decorator with the rate-guard template.
- **New read-only agent tool**: implement `ITool` under `output/tools/`, add to `TOOL_TYPE` enum, register in `SystemToolProviderConcrete.getTools()`. For soft-disabled tools, take an `isDisabled: () => boolean` and return `{ success: false, error: "<feature>_unavailable" }` when set. Read-only tools must never trigger autosign or mutations.
- **New cross-chain capability**: (a) add the chain to `CHAIN_REGISTRY`; (b) define adapter port(s) under `interface/output/<feature>/`; (c) per-step `chainId` on the execution plan so the mini-app session can sequence home-chain bridge legs with venue-chain action legs; (d) add a soft-disable getter + 503 path on the HTTP routes; (e) flip `relayEnabled: true` on the venue chain once the bridge round-trip is smoke-tested.

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

## Production topology (Fly.io, app `aegis-core`, region `iad`)

| Process | Role | Public | Scaling |
|---|---|---|---|
| `app` (single combined machine) | `combined` — http + worker + telegram in one node (`PROCESS_ROLE=combined`, dispatched by `entrypoint.ts`) | yes | `min_machines_running = 1`, `auto_stop_machines = "off"`, `auto_start_machines = true` |

VM: `shared-cpu-2x`, `cpus = 2`, `memory = "2gb"`. HTTP service: `internal_port = 4000`, `force_https = true`, concurrency `soft_limit = 200` / `hard_limit = 250`. Lightweight TCP healthcheck on `:4000` (no app-level `/health` required by Fly). Boot runs migrations. The combined process owns the gramJS MTProto socket + cron timers, so the machine must stay hot — `auto_stop_machines = "off"` is mandatory; do not raise replica count without first sharding telegram polling and cron locks (>1 replica would duplicate both). External: Neon Postgres + Upstash Redis (both `us-east-1`, co-located with `iad`).

**Secrets.** Managed via `fly secrets set` against app `aegis-core`. Source of truth is the local, gitignored `be/fly-secrets.sh` (idempotent — re-running overwrites). Workflow: edit the script, `./fly-secrets.sh` (uses `--stage`, no auto-restart), then `fly deploy --app aegis-core` to apply. For one-off rotations, `fly secrets set KEY=value --app aegis-core` triggers a rolling restart. List with `fly secrets list --app aegis-core`. Non-secret env lives inline in `fly.toml [env]`.

**Deploy.** Manual: `fly deploy --app aegis-core` from `be/`. Fly builds the Dockerfile remotely (or locally with `--local-only`) and rolls the machine.

**Image build (`be/Dockerfile`).** Two-stage, both `node:20.19-slim` (debian/glibc — `prebuild-install` finds glibc prebuilts for `bufferutil`/`utf-8-validate`, usually skipping the gyp compile entirely). Builder `apt-get install python3 make g++` (fallback for any native dep without a prebuilt) under BuildKit cache mounts (`/var/cache/apt`, `/var/lib/apt/lists`). `npm ci --prefer-offline` with `--mount=type=cache,target=/root/.npm`, then a single esbuild bundle from `src/entrypoint.ts` → `dist/server.js` (minified, **no sourcemap** — re-add `--sourcemap=external` and copy the `.map` to a Sentry-upload step OUTSIDE the runtime COPY if you ever wire one up). **Layer ordering matters for cache reuse**: `package*.json` copy and `npm ci` come BEFORE `tsconfig.json` and `src/`, so the typical edit-src rebuild only re-runs the esbuild layer (a few seconds). Build-arg `MINIFY` (default `true`) — pass `--build-arg MINIFY=false` for dev iteration, ~3× faster esbuild for a 3× larger bundle. **Required runtime native modules**: gramjs/`websocket` hard-require `bufferutil` (no JS fallback), so we copy `bufferutil`, `utf-8-validate`, `node-gyp-build` from builder into the runtime stage. Runtime image copies the pino transport tree + those three native packages into `node_modules/`. Drizzle SQL ships under `/app/drizzle` for boot-time migrate. `USER node` is set. **Cross-arch builds (Apple Silicon → linux/amd64) run under QEMU and are slow** — Fly's remote builder is amd64 native, so `fly deploy` (without `--local-only`) avoids the QEMU penalty.

---

## Feature log (condensed — see `output/capabilities/status.md` and `constructions/` for full notes)

### Active surface

- **2026-05-08 — Tokenized stocks (Aster) feature removed.** Capabilities (`StockCapability`, `PositionsCapability`), `IStockUseCase` + sub-ports, `aster/` + `stocks/` adapter folders, `get_stock_*` / `stock_open` LLM tools + `TOOL_TYPE` entries, `verifyStockCapability()` boot hook + `_stockCapabilityDisabled` flag, `STOCK_RECOVERY_ENABLED` / `ASTER_*` / `BSC_USDC` / `BSC_RPC_URL` env vars, `/stocks/*` HTTP routes, `/stock` + `/positions` Telegram commands + the `/buy` reroute, and `stock_open_long|short|close` loyalty action types are all gone. Migration `0032_drop_stock_features.sql`. BSC chain (56) stays in `CHAIN_REGISTRY` (no current consumer). `signingRequest.cache.ts:planKind: "recovery"` discriminator remains wired but unused.

### Prediction markets (Polymarket pipeline, stages 1–4)

- **2026-05-07 — Stage 4 BE foundation, BE finish, hardening, FE-side gaps.** Full bet/close/poller/receipts/setup-state-machine/encryption/HTTP-routes/chain-config/`PlaceBetCapability`/`ClosePositionCapability` ship behind `PREDICTION_MARKETS_BETS_ENABLED=false`. **READ FIRST before flipping the flag** — open-work list (12 items, ordered by severity) lives in `constructions/2026-05-07-prediction-markets-stage4.md`. The two ship-blockers: (1) bridge-initiation endpoint missing — `INITIATED → BRIDGING` transition has no BE call to start the Avax→Polygon Relay quote; FE polls and dead-ends. (2) FE `pmApi.finalizePosition` POSTs `/predictionMarket/position/:id/finalize` which doesn't exist — drop the FE call (BE `/bet/:id/finalize` already routes closes via `findPositionByClosingBetId`). Items 3–8 are EIP-712 / HMAC / sigType verifications resolvable by a `$1` mainnet validation run. Items 9–12 are launch-readiness + post-launch.
- **Bet pipeline conventions (load-bearing).** (i) `IPredictionMarketBetRepository.updateBetStatus` validates moves against `BET_STATE_TRANSITIONS` inside a `SELECT … FOR UPDATE` txn; throws `IllegalBetTransitionError` → HTTP 409. Never absorb. (ii) Setup-step transitions are linear-monotonic (forward-by-≤1 or same). (iii) One in-flight bet per user (`countOpenBetsForUser` excludes terminal states; PARTIAL counts as in-flight until refund UserOp lands). (iv) Refunds on EOA after non-fill terminations are an in-band flag (`refundRequired`) on the bet row; FE submits a paymaster-sponsored EOA→SCA sweep on next mini-app open. (v) Receipts are pushed by `IPredictionMarketReceiptBroadcaster` (telegram-direct), never inline in handlers. (vi) Polymarket maker calls funnel through `IPolymarketAdapter` with explicit `makerAddress` + creds-envelope params — no stored client. (vii) When local position diverges from `/data/positions`, Polymarket wins. (viii) Position lifecycle: `open → closing → closed` (user-initiated), `open → resolved` (Polymarket-side), `open → closed` (silent, manual web close). (ix) `clientOrderId` (uuid, UNIQUE) is the Polymarket idempotency key. (x) Write-side and read-side prediction-market repos stay split. (xi) Polymarket exchange/CTF/NegRisk addresses live exclusively in `chainConfig.ts:CHAIN_REGISTRY[137].polymarket` via `getPolymarketConfig(chainId)`.
- **Polymarket adapter — custom HTTP, NOT `@polymarket/clob-client`.** SDK depends on ethers v5; codebase is viem-only. Adapter wraps `/auth/api-key`, `/book`, `POST /order`, `DELETE /order`, `/data/order/:id`, `/data/positions` with L2 HMAC headers. EOA-signed orders forwarded verbatim from FE. ABI-compatible with `ClobClient` shape so a swap is mechanical.
- **2026-05-07 — Stage 3 mispricing detection.** Per-tick `detect → verify → broadcast` over high-confidence clusters. Four patterns: `logical_inconsistency` / `term_structure_anomaly` / `implied_contradiction` / `movement_divergence`. Detector cache key `sha256(clusterId + sortedMembers@bucketedYesPriceBp + promptVersion + model)` (50bp bucket, 30-min TTL). Verifier re-fetches via `IPredictionMarketProvider.fetchByIds` (Polymarket Gamma `?condition_ids=`, batched 50/req); drops on hallucinated ids, sub-$25k liquidity, >50bp odds drift, or pattern-gap < 100bp. `rankScore = patternWeight × confidenceWeight × min(gap/1000, 1) × log10(minLiquidity)` (×1000 to fit `integer`). Per-user dedupe `pm:finding:lastSeen:{userId}:{findingId}` (7d) — cross-run dedupe intentionally absent. Carry-forward stable cluster IDs across cache-hit reclusters so `prediction_market_findings.cluster_id` correlates over runs. Default `PREDICTION_MARKETS_FINDINGS_ENABLED=false`.
- **2026-05-06 — Stage 1+2 scan.** Worker-only job polls Polymarket Gamma every `PREDICTION_MARKETS_FETCH_INTERVAL_MS` (30 min default), filters to top-100 binary YES/NO markets meeting OI/volume/window/criteria thresholds, persists versioned snapshot with `is_latest=true` (atomic flip in txn). Stage 2 (LLM clustering) runs only on universe-hash change OR > `RECLUSTER_DELTA` churn OR > `MAX_RECLUSTER_AGE_MS` since last clustering. Classifier uses structured outputs (`response_format: json_schema, strict`) keyed on `(promptVersion, model, sha256(sortedMarketIds@resolutionEpochs))`; overlapping market_ids dropped lower-confidence-first. Multi-replica safe via `pm:scan:lock` (`SET NX PX`). Money columns are `bigint` cents; prices are `integer` basis points. `setLatestRun(runId)` is the only sanctioned way to flip the latest pointer.
- **2026-05-07 — Cluster broadcast suppressed.** `getPredictionMarketScanUseCase` passes `null` for the cluster `IPredictionMarketBroadcaster`; only per-finding messages reach users. Class + DI getter + `pm:broadcast:lastHash:{userId}` Redis key kept for one-line revert.

### Result-card framework + auto-resume + NL routing

- **2026-05-04/05 — Result-card framework (P1 → P7+).** Single canonical capability outcome shape (`IntentResult`) with `result_card` artifact. Renderer (`adapters/.../artifactRenderer/resultCard.{render,escape}.ts`) is the **only** place touching Telegram MarkdownV2; `escapeMd` runs over every capability-supplied substring. Conventions: terminal outcomes are `result_card`, never `chat`; capabilities never write MarkdownV2; capabilities never inline error strings — they call `interpretError(err, { verb, requestId })` from `helpers/errors/errorCatalog.ts`. New verbs go on `IntentVerb`; new error codes go on `ErrorCode` AND its `PATTERNS` table. Sign-request `preview: buildPreview({...})` attached to FIRST `SigningRequestRecord` only (subsequent steps `preview: undefined`). `complexity:"complex"` reserved for cross-chain swaps + multi-step flows + yield rebalance — single-token sends and same-chain single-step swaps default to `"simple"` so the interpreter never fires. Read-only query capabilities emit `result_card{status:"success"}` even on the empty path. `IIntentInterpreter` (OpenAI adapter, 2s timeout, optional Redis cache `interp:` ns 5-min TTL, ≤25-word output) gated by `RESULT_CARD_INTERPRETER_ENABLED` AND `OPENAI_API_KEY`.
- **2026-05-05 — Auto-resume after Aegis-Guard reapproval.** Capabilities returning `kind:"mini_app"` for an `aegis_guard` reapproval MUST persist resolved params via `IPendingIntentStore` keyed by `guard.reapprovalRequest.requestId`. `dispatcher.resume()` is the only sanctioned way to re-enter a capability with already-resolved params. Swap params include `forceRequote?: boolean` set on resume. The http-only `httpCli` replica has no dispatcher — graceful degradation falls back to a "please re-issue" message.
- **2026-05-05 — Unify NL onto slash-command dispatcher.** Free-text "swap …" / "send …" / "deposit into yield" route through the **same** `route_intent` LLM tool path as `/`-prefixed commands. Byte-identical signing payloads, same Aegis-Guard gate, same logs. New capabilities reach NL by adding their `INTENT_COMMAND` to `routeIntent.tool.ts:COMMAND_VALUES` — no per-feature LLM tool. Removed (legacy parallel intent path): `ExecuteIntentTool`, `TransferErc20Tool`, `OpenAIIntentParser`, `OpenAIIntentClassifier`, `IIntentParser`, `IIntentClassifier`, `ClaimRewardsSolver`, `validateIntent`, `IntentUseCase.{parseAndExecute,classifyIntent}`, the `intent.errors` module, the `execute_intent` LLM tool. Kept (load-bearing): `IntentUseCase.{searchTokens, selectTool, compileSchema, buildRequestBody, generateMissingParamQuestion}`, `SolverRegistry` + `ManifestDrivenSolver` (sendCapability builds ERC-20 calldata via manifests), `ISchemaCompiler`. `intents` + `intent_executions` tables remain for `transferHistory.usecase` enrichment but write-free.
- **2026-05-05 — Drop dynamic tool registry (Phases A + B).** `POST/GET/DELETE /tools`, `/command-mappings`, `/http-tools` HTTP routes + their use-cases + `httpQueryTool` repos + `helpers/crypto/aes.ts` (only consumer was httpQueryTool) all deleted. `sendCapability` owns an in-code `SEND_MANIFEST: CapabilityManifest` and a private `buildTransferCalldata` helper mirroring `executeErc20Transfer` byte-for-byte (native = recipient/`0x`/value-raw; ERC-20 = `viem.encodeFunctionData(erc20Abi, "transfer", …)`). `IIntentUseCase` exposes only `searchTokens`/`compileSchema`/`generateMissingParamQuestion`. New convention: capability tools register their own `CapabilityManifest` constant inline; calldata is built directly inside the capability rather than going through a solver.

### Yield

- **2026-05-04 — Auto-rebalance.** `runPoolScan` maintains `yield:winner_streak:{chainId}:{token}` Redis record (TTL `4 × poolScanIntervalMs`) so a switch must persist for `YIELD_REBALANCE_STICKY_SCANS=3` consecutive scans before nudging. `userIdleScanJob` calls `scanRebalanceForUser` as a sibling step to `scanIdleForUser` — both gated by their own Redis cooldowns (`yield:rebalance_cooldown:{userId}` 24h; `yield:rebalance_pending:{userId}` 1h). `YieldCapability` owns both `yield:` and `rebalance:` callback prefixes (`TriggerSpec.callbackPrefix: string | string[]`). On rebalance only the supply leg gets `tokenAddress + amountRaw` (the withdraw burns aTokens). Without a second adapter the path stays dormant in production.
- **2026-05-04 — Yield bug-fix batch.** EMA ranker uses `α = 2/(N+1)` on newest-first APY history. Aave V3 APY formula verified against Aave's `aave-utilities` `calculateCompoundedInterest` (matches `app.aave.com`). `yieldReportJob` user discovery unions `listUsersWithRecentSnapshots` ∪ `telegramSessions.listActiveUserIds`, fan-out via `pLimit(5)`. `IYieldRepository.listSnapshotsBetween(userId, fromInclusive, toExclusive)` replaces the off-by-one `listSnapshots(_, sinceEpoch-1)`. `finalizeWithdrawal` re-discovers + `upsertSnapshot` per (chain, protocol, token); failures `warn` and never rethrow. `SubgraphPrincipalProvider` warns once at boot when `THEGRAPH_API_KEY` is unset; `status(): "ok"|"degraded"|"disabled"` surfaced via `/health`.
- **2026-04-28 — Yield positions revamp.** Active-protocol discovery is on-chain (`OnChainPositionDiscovery` fans out across `protocol × stablecoin`); principal source is The Graph Messari Aave V3 subgraph. `yield_deposits` + `yield_withdrawals` tables **dropped** (`0026_stale_mandrill.sql`). `buildDepositPlan` no longer writes a DB row. `finalizeWithdrawal` is a no-op (positions are snapshots).
- **2026-04-24 — Yield optimizer.** Avalanche mainnet, Aave v3. Ranking: `score = 0.7·EMA_7d(supplyApy) + 0.3·currentSupplyApy`; disqualify if liquidity < $100k; ×0.5 if utilization > 95%.

### Send / swap / buy / loyalty / chain primitives

- **2026-05-04 — Native via synthesis.** `NATIVE_PSEUDO_ADDRESS` + `getNativeTokenInfo(chainId)` in `chainConfig.ts`; `DbTokenRegistryService` synthesizes the native row (no DB seed). `manifestSolver/stepExecutors.executeErc20Transfer` branches on `isNativeAddress` to emit `{ value: amountRaw, data: "0x" }`.
- **2026-05-04 — Native auto-sign.** `sendCapability` removed the `!fromToken.isNative` guard; native sends share the autosign branch. `awardPoints` branches `send_native` vs `send_erc20`.
- **2026-05-04 — Ankr transfer history.** `ITransferHistoryProvider` port; `AnkrTransferHistoryProvider` merges `getTransactionsByAddress` + `getTokenTransfers`. `CachedTransferHistoryProvider` adds Redis cache + per-user RPM + global RPS + stale-on-gate-refusal. `GET /transfers` route. New agent tool `get_transfer_history`. Cursor opaque (Ankr `{tx, token}` JSON).
- **2026-05-03 — Self-derived recipient SCA.** `helpers/aaConfig.ts` + `deriveScaAddress.ts` (1h LRU). `userProfile.repo.findByEoaAddress`; `eoa_address` lowercased on write. Resolver/sendCapability fall back to `deriveScaAddress` for un-onboarded recipients (was returning EOA — funds unreachable). `scripts/verify-sca-derivation.ts` proved 100% match against Privy's derivation.
- **2026-04-28 — Delegation spend bookkeeping.** `signingRequest.usecase.resolveRequest` calls `tokenDelegationDB.addSpent` when `tokenAddress`+`amountRaw` are present. `swapCapability` only tags the last step; `yieldCapability` deposits tag `plan.amountRaw`, withdrawals omit. `upsertMany` preserves `spent_raw` when `limit_raw` unchanged.
- **2026-04-28 — Recipient notifications.** `RecipientNotificationUseCase` + `recipient_notifications` table. `dispatchP2PSend` (best-effort) at every successful p2p send via `buildNotifyResolved`. `flushPendingForTelegramUser` runs on `/start` + auth.
- **2026-04-28 — Ankr-backed portfolio.** `IBalanceProvider` port; `AnkrBalanceProvider` (single HTTP call) wrapped in `CachedBalanceProvider` (30s in-memory TTL). Feature-flagged via `PORTFOLIO_PROVIDER`. Fuji has no `ankrBlockchain` and always uses RPC.
- **2026-04-27 — Sign-resolution UX.** Shared `helpers/notifyResolved.ts`. Decodes ERC-20 transfers; success → explorer link via `getExplorerTxUrl(chainId, txHash)`. `insufficient_token_balance` + USDC → `buy:y/<amount>` keyboard.
- **2026-04-27 — `/swap` + `/yield` UX parity with `/send`.** Single mini-app session per intent (step 1 emits `mini_app`; rest stored via `miniAppRequestCache`). `swapCapability` short-circuits USDC via `getUsdcAddress(chainId)`. Final swap completion includes explorer InlineKeyboard. swap bugfixes: pass `smartAccountAddress` (not EOA) to Relay; `chainId` on every step.
- **2026-04-27 — Global `$ → USDC` normalization.** `normalizeFiatAmount` runs in `OpenAISchemaCompiler.compile` for all capabilities.
- **2026-04-25 — Loyalty Program (Season 0).** `computePointsV1` formula, idempotent on `intent_execution_id`. Canonical action types: `swap_same_chain`, `swap_cross_chain`, `send_erc20`, `send_native`, `yield_deposit`, `yield_hold_day` (deferred), `referral`, `manual_adjust`. Fire-and-forget at all call sites. `LOYALTY_STATUSES` on `users`: `normal/flagged/forbidden`.
- **2026-04-24 — Swap (Relay).** `SwapCapability`. Aegis Guard check → `RelaySwapTool.execute` → per-step `SigningRequest`. Multi-step continuation via `?after=<prevId>` (Redis ZSET `user_pending_signs:<userId>`).
- **2026-04-23 — Onramp `/buy`.** `BuyCapability` bypasses `selectTool`/manifests. `buy:y` → SCA address; `buy:n` → `OnrampRequest` mini-app.

### Platform / observability / scaling

- **2026-05-05 — Sign-error diagnostics.** `POST /response` schema gained optional `errorRaw: string (≤1024)`; FE `SignHandler` sends `msg.slice(0, 1024)` (raw `${err.name}: ${err.message}`) alongside `errorCode`/`errorMessage`. `signingRequest.usecase.resolveRequest` emits `warn` `step:"signing-request-rejected-raw"` carrying `errorRaw + requestId + userId + errorCode`. Diagnostic-only — never re-displayed to users, never persisted in cache.
- **2026-04-25 — Cloud Run CI/CD + healthcheck + auth hardening.** `POST /health` (unauth, no secrets). Admin gate (`ADMIN_PRIVY_DIDS`) on admin routes. Ownership gate on `GET /permissions`, `GET /request/:id` (non-auth). `POST /response` auth bypasses `resolveUserId`.
- **2026-04-24 — Scaling.** DB pool `max:25`. `MESSAGE_HISTORY_LIMIT=30`. OpenAI global concurrency cap. DateTime out of system prompt → prefix-cache stays warm. Privy `verifyTokenLite` LRU. Redis-backed `IPendingCollectionStore`. Multi-replica safe session reads (Postgres). Tavily + Relay quote cached in Redis. `ChainEntry.defaultRpcUrls` is `string[]` (viem `fallback`).
- **2026-04-24 — Structured logging.** All `console.*` migrated to pino. Singleton `helpers/observability/logger.ts:createLogger`.
- **2026-04-23 — Capability refactor.** All Telegram flows through `ICapabilityDispatcher`. `handler.ts` ~200 LOC (was 1146). `TriggerSpec.commands[]` for multi-command capabilities. Pending state must be JSON-safe.

## Backlog
- Proactive daily market sentiment → investment verdict agent.
- Aegis Guard agent-side enforcement: pre-UserOp re-check `limitRaw - spentRaw + validUntil`.
- `yield_hold_day` daily award (needs worker pass).
- Admin HTTP endpoint for `adjustPoints` (clawbacks).
- Cross-chain swap: destination-fill polling (`Relay /intents/status/v2`).
- Multi-stablecoin yield, partial withdrawal, additional yield adapters (Benqi/Yearn).
- Thread sender username through `CapabilityCtx.meta` so `recipient_notifications.senderHandle` is no longer always null.
