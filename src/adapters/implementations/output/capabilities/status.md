# Capabilities Status

## Native token auto-sign — 2026-05-04

**What was done:**
- `sendCapability.ts:191`: removed the `!fromToken.isNative` guard from the auto-sign branch. Native sends now go through the same `checkTokenDelegation` → `sign_calldata { autoSign: true }` flow as ERC-20.
- `sendCapability.ts:239` (and the manual-path mirror): `awardPoints({ actionType })` now branches on `resolvedFrom.isNative` → `"send_native"` vs `"send_erc20"`.
- `loyaltyCapability.ts`: registered `send_native` in `ACTION_LABELS` ("send (native)"). Loyalty point base/multiplier falls back to `actionDefaults` until a season explicitly prices it.

**Why:**
- The session-key validator on the SCA uses `toSudoPolicy({})` (`fe/privy-auth/src/utils/crypto.ts:154`) — the session key already has unrestricted on-chain authority over the SCA, including arbitrary value transfers. There's no additional on-chain delegation native sends were missing.
- The "approval" flow in this codebase is **purely off-chain**: `/delegation/approval-params` → onboarding mini-app → `/delegation/grant` upserts a `tokenDelegations` row. No `approve()` ever gets called on-chain. Native plugs into this flow with `tokenAddress = NATIVE_PSEUDO_ADDRESS`. The estimator (`deterministic.executionEstimator.ts`) and `addSpent` (`signingRequest.usecase.ts:76`) both key on lowercased `tokenAddress`, so native works without any change to those.
- Net result: the only thing blocking native auto-sign was the explicit guard.

**New convention:**
- `tokenDelegations` rows for native are valid and expected. They share schema with ERC-20 delegations (`tokenAddress = NATIVE_PSEUDO_ADDRESS`, `tokenSymbol = AVAX/ETH/POL/...`, `tokenDecimals = 18`). The "delegation" semantically means "off-chain spend budget", not "on-chain allowance".
- `tryEmitDelegationRequest` (`sendCapability.ts:749`) still skips native — that path emits an ERC-20 `approve()` ZeroDev message via `delegationBuilder.buildErc20Spend`, which has no native equivalent. Native users always reach the auto-sign branch (or the onboarding flow if no delegation exists yet); they should never enter `tryEmitDelegationRequest`.

## Native token support via synthesis — 2026-05-04

**What was done:**
- `helpers/chainConfig.ts`: added `NATIVE_PSEUDO_ADDRESS` (`0xEeee…EEeE`), `isNativeAddress`, `isNativeSymbolForChain`, and `getNativeTokenInfo(chainId)` — sourced from viem's `Chain.nativeCurrency` plus our registry's `nativeSymbol`.
- `DbTokenRegistryService` (`adapters/.../tokenRegistry/db.tokenRegistry.ts`): all four service methods (`resolve`, `findByAddressAndChain`, `searchBySymbol`, `listByChain`) now synthesise an in-memory `ITokenRecord` for the chain's native token instead of reading it from the DB. `searchBySymbol` exact-matches the native symbol short-circuit to a single candidate so users typing `avax`/`eth`/`pol` are never asked to disambiguate against AVAX-suffixed ERC-20s.
- `manifestSolver/stepExecutors.ts`: `executeErc20Transfer` branches on `isNativeAddress(tokenAddress)` and emits `{ to: recipient, data: "0x", value: amountRaw }` for native sends. ERC-20 path unchanged.
- `drizzle/seed/tokenRegistry.ts`: removed the seeded native AVAX rows. Native tokens are no longer DB-resident.
- `httpServer.ts` `GET /delegation/approval-params`: the previously hardcoded `NATIVE_ADDRESS` block now uses `getNativeTokenInfo(chainId)` for symbol/decimals; suggested limit scales with `native.decimals`.

**Why:**
- The intent parser ran a substring `ILIKE '%avax%'` query and never short-circuited on exact symbol match, so typing `/send 0.5 avax` returned a 10-token disambiguation list of *AVAX-suffixed ERC-20s with the native row buried or missing entirely (the seed's `(symbol, chainId)` upsert key is collision-prone with the indexer).
- Synthesising native rows from chain config makes native support automatic for every registered chain (no per-chain seed maintenance) and makes the indexer collision impossible.
- viem already encodes `nativeCurrency.{name,symbol,decimals}` per chain — single source of truth, no drift.

**New convention (do not break):**
- The canonical native pseudo-address is `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` (mixed-case checksum). Always compare via `isNativeAddress(addr)` (case-insensitive) — never `===`.
- Never insert native rows into `tokenRegistry`. If you discover one (e.g. from a misbehaving indexer), drop it; `DbTokenRegistryService.searchBySymbol` / `listByChain` filter native-pseudo-address rows out of DB results before prepending the synth row, so a stray seed won't break things, but it's still wrong.
- `executeErc20Transfer` is the single place that turns the native pseudo-address into a value send. Don't add a parallel `native_transfer` step kind unless you have a reason — the existing `transferToken` tool manifest works for both ERC-20 and native.

## Self-derived recipient SCA — 2026-05-03

**What was done:**
- New `helpers/aaConfig.ts` and `helpers/deriveScaAddress.ts` — single source of truth for the AA stack (entry point 0.7, Kernel V3.1, `index = 0n`) and a counterfactual SCA derivation helper with a 1h LRU.
- `chainConfig.ts`: added `getViemChain` and `getRpcUrlForChain` wrappers used by AA derivation.
- `userProfile.repo` (interface + Drizzle impl): added `findByEoaAddress(eoa)`. `upsert`/`update` now lowercase `eoaAddress` on write so `findByEoaAddress` can match deterministically.
- `resolverEngine.resolve` (handle path) and `sendCapability.resolveRecipientHandle`: recipient resolution is now `eoa → DB profile.smartAccountAddress` if onboarded, otherwise `deriveScaAddress(eoa, chainId)`. Previously both paths returned the recipient's EOA verbatim — fund recipients silently saw an EOA instead of the SCA they would later own.
- New script `scripts/verify-sca-derivation.ts` (one-off): proves `AA_CONFIG.index = 0n` matches Privy's hosted-smart-wallets default by deriving every onboarded user's SCA and diffing against the stored value. Required to pass with 100% match before this change is enabled.

**Why:**
- Privy's hosted smart-wallets product owned both the Kernel constants and the address-derivation logic; SDK or dashboard changes could silently change a user's SCA out from under us. Pinning the AA constants in our own config and deriving the address ourselves removes that dependency.
- Recipient resolution was the user-visible bug: handles for un-onboarded recipients resolved to an EOA address that the recipient would never own once they onboard, so funds were effectively unrecoverable. Self-derivation produces the counterfactual SCA which the recipient *will* own when they onboard with the same Privy EOA.

**New conventions:**
- AA stack constants live exclusively in `helpers/aaConfig.ts`. Never inline `entryPoint`, `kernelVersion`, or `index` elsewhere.
- `eoa_address` is canonicalized to lowercase on write. Lookups by EOA must lowercase the search term.
- DB row is canonical when present; derivation is fallback-only. Existing onboarded users' stored SCA always wins over a fresh derivation, protecting them from any future change to `AA_CONFIG`.
- New log metadata field: `source: "db" | "derived"` on the `step: "wallet-resolved"` event so we can track recipient resolution origin.

## Delegation spend bookkeeping — 2026-04-28

**What was done:**
- `SigningRequestRecord` (cache): added optional `tokenAddress` + `amountRaw`. When present on a non-rejected `resolveRequest`, `signingRequest.usecase` calls `tokenDelegationDB.addSpent(userId, tokenAddress, amountRaw)` in a try/catch (logs `addSpent failed` on error; never breaks user-facing resolution).
- `SigningRequestUseCaseImpl` constructor now takes an optional `ITokenDelegationDB`; wired in `assistant.di.ts::getSigningRequestUseCase`.
- `Artifact.sign_calldata`: added optional `tokenAddress` + `amountRaw` (passed through by `telegram.ts` into the `SigningRequestRecord`). `sendCapability` autosign branch sets them from `fromToken.address.toLowerCase()` + `partialParams.amountRaw`.
- `swapCapability.run`: only the **last** step's record carries `tokenAddress`/`amountRaw` (and only when `!fromToken.isNative`) — avoids double-counting approve + swap.
- `yieldCapability.executeSignSteps`: new `spendAmountRaw?` param. When set, the last step's record is tagged. Deposits pass `plan.amountRaw`; withdrawals omit it (a withdrawal burns the protocol receipt token, it does not consume the user's underlying-token delegation).
- `tokenDelegation.repo.upsertMany`: `onConflictDoUpdate` now preserves `spent_raw` when `limit_raw` is unchanged via `CASE WHEN ... THEN spent_raw ELSE '0' END`. Previous behavior reset to `'0'` on every re-grant, which wiped the FE permissions bar after every session refresh.

**Why:**
- `addSpent` was defined on the repo and interface but had **zero call sites** anywhere in the codebase. Capabilities only called `checkTokenDelegation` (a pre-flight read). The on-chain delegation enforced the limit, but `token_delegations.spent_raw` stayed at `'0'`, so `ConfigsTab.PermissionsSection`'s progress bar never moved despite real autosigned spends.
- Per-step attribution would double-count multi-tx flows (approve + swap, approve + deposit). `TxStep` has no role marker and Relay's tx list doesn't either, so attributing only on the final step is the cleanest heuristic that doesn't require selector inspection.
- Withdrawals don't consume the underlying-token delegation, so they intentionally skip `addSpent`.

**New conventions:**
- Capabilities that emit autosign signing-requests for ERC20 spends MUST set `tokenAddress` + `amountRaw` on the `SigningRequestRecord` (or the `sign_calldata` artifact) of the **single tx that actually moves the user's funds** — typically the last step of the sequence. Native-token paths leave both undefined.
- Spend metadata fields on `SigningRequestRecord`: `tokenAddress` (lowercased ERC20 address), `amountRaw` (decimal string of the raw spend, matching the delegation's `limit_raw` units).

## /yield one-click UX parity with /swap — 2026-04-27

**What was done:**
- `yieldCapability.runDeposit` / `runWithdraw`: emit a single Markdown quote summary (`buildDepositQuoteSummary` / `buildWithdrawQuoteSummary`) before sequencing the steps, mirroring `swapCapability.buildQuoteSummary`.
- `yieldCapability.executeSignSteps`: only step 1 emits the `mini_app` button. Subsequent steps are stored via `miniAppRequestCache.store(...)` and chained by the FE's `YieldDepositHandler` (which already calls `fetchNextRequest`). The user opens the mini app exactly once per deposit/withdrawal — no more "Yield deposit step 2/2 — tap to execute automatically." follow-up button.
- Caller passes `buttonText` and `promptText` so the deposit and withdrawal flows can use distinct copy.
- `YIELD_REPORT_INTERVAL_MS` env added (`yieldEnv.reportIntervalMs`). When > 0, `YieldReportJob` runs at that interval and skips the daily UTC-hour gate + `report_done:{date}` redis dedupe; when 0/unset, behavior matches the previous daily report.

**Why:**
- The yield flow already had `autoSign: true` and `fetchNextRequest` support on the FE, but the BE was emitting a per-step Telegram button. That broke the "one tap, all steps signed in a single mini-app session" UX that `/swap` and `/send` already deliver.
- The interval-based report knob is a debug/QA convenience requested for the current iteration (set to 120000 in `be/.env`). Daily reports remain the production default.

**Conventions reinforced:**
- Same as the swap convention below: capabilities producing N>1 signing steps emit `mini_app` for step 1 only, store steps 2..N via `miniAppRequestCache.store(...)`, and rely on the FE's `fetchNextRequest` chaining.

## /swap UX parity with /send — 2026-04-27

**What was done:**
- `swapCapability.finishCompileOrResolve`: when either `tokenSymbols.from` or `tokenSymbols.to` is `"USDC"` (post fiat-normalisation), inject the chain-canonical USDC address from `getUsdcAddress(chainId)` into the matching resolver field. Mirrors `/send`'s short-circuit so `/swap $1 to avax` no longer prompts the user to choose between USDC and USDC.E.
- `swapCapability.run`: emit the `mini_app` button only for the first Relay step. Subsequent steps are stored directly via `miniAppRequestCache.store(...)` so the FE's `SignHandler` chains to them via `GET /request/:id?after=<prev>` without re-opening the WebApp. The user opens the mini app exactly once per swap.
- Final completion message now carries an `InlineKeyboard().url("🔍 View on explorer", ...)` keyboard for the last (settlement) tx, mirroring `notifyResolved`'s success UX.
- Added `miniAppRequestCache?: IMiniAppRequestCache` to `SwapCapabilityDeps` (wired in `assistant.di.ts`).

**Why:**
- Previous flow forced the user to disambiguate USDC for every fiat-amount swap — friction not present in `/send` even though `getUsdcAddress` has been the canonical source for chain-USDC since the global $-normalisation work above.
- Per-step Telegram buttons made the user re-open the mini app for every leg of a swap (typically approve + swap = 2 taps). The `fetchNextRequest` chaining mechanism already existed (used by yield) — `/swap` just wasn't using it.
- Plain-text hash list with no explorer link broke the "see your tx on chain" UX `/send` users already expect.

**Conventions introduced:**
- Capabilities that produce N>1 sequential signing steps and want a single mini-app session should: emit `mini_app` for step 1 only, store steps 2..N via `miniAppRequestCache.store(...)`, and rely on the FE's `fetchNextRequest` chaining. Each step still creates a `SigningRequestRecord` so `waitFor` resolves correctly.
- For symmetry with `/send`, capabilities that recognise `"USDC"` as a token symbol should resolve it via `getUsdcAddress(chainId)` rather than letting the registry search ambiguate it.

## Global $ → USDC normalization — 2026-04-27

**What was done:**
- Added `normalizeFiatAmount(text)` to `send.utils.ts`. Replaces `$N`/`$ N` with `N USDC` and `N dollars/bucks/usd` (not `usdc`) with `N USDC`. `N usdc` is left as-is (already unambiguous).
- `OpenAISchemaCompiler.compile()` now maps all incoming messages through `normalizeFiatAmount` before building the LLM user content. This means the LLM always sees "5 USDC" instead of "$5", regardless of which capability triggered the compile.
- Added one-line instruction to the schema compiler system prompt: "Dollar amounts always refer to USDC."
- `sendCapability`'s existing `detectStablecoinIntent` + USDC address injection is untouched — it overwrites the LLM-extracted symbol with the exact chain contract address, preventing disambiguation. That remains as sendCapability's own defense.

**Why this approach:**
- Previously, `$` detection lived only in `sendCapability`. `/swap $5 for ETH` would fail to extract the USDC token because the swap compile loop never ran the fiat guard.
- Normalizing at the schema compiler level is the single point where all capabilities feed through — one change covers all current and future tools.
- Text pre-processing is deterministic and cheap; it removes a class of LLM ambiguity without adding model calls.

**New conventions:**
- Any new capability that uses `intentUseCase.compileSchema` automatically inherits the `$` → USDC normalization. No per-capability fiat handling needed.
- `detectStablecoinIntent` is now only for sendCapability's address-injection guard; don't add it to new capabilities.

## /swap bugfixes — 2026-04-27

**What was done:**
- Fixed `swapCapability.ts`: fetch `smartAccountAddress` via `userProfileRepo` instead of using `fromResolved.senderAddress` (which was `eoaAddress`). The SCA is the account that holds tokens; passing the EOA to Relay would produce quotes for an empty account.
- Fixed `swapCapability.ts`: added `chainId: params.fromChainId` to every `SignRequest` emitted during the step loop. The FE's `SignHandler` defaults to `VITE_CHAIN_ID` when chainId is absent — correct for Avalanche but wrong for all other Relay-supported chains.
- Replaced inline `toRawAmount` with `toRaw` from `helpers/bigint` (shared BigInt-safe helper).
- Added `createLogger('swapCapability')` with step lifecycle logs (`started`, `resolved`, `submitted`, `succeeded`, `failed`) and `createLogger('relaySwapTool')` with `→`/`←` debug logs for the Relay HTTP call.

**Why:**
- `eoaAddress` is the Privy embedded-wallet signer key. `smartAccountAddress` is the ZeroDev Kernel account. All on-chain balances live in the Kernel account; every other use-case that touches the user's funds (`buyCapability`, `yieldOptimizerUseCase`, `portfolio`) uses `smartAccountAddress`.
- `chainId` omission was safe by accident for Avalanche-only same-chain swaps but would silently sign on the wrong chain for any cross-chain or non-default-chain swap.

**New conventions:**
- Capabilities that call Relay must pass `smartAccountAddress` as `user`/`recipient` — not `resolverEngine.senderAddress`.
- All Relay-quote-step `SignRequest`s carry `chainId: fromChainId` (steps are always on the origin chain; the solver handles destination delivery).

## Recipient Notifications (Path A) — 2026-04-27

**What was done:**
- Added `recipient_notifications` table (schema + migration `0025_oval_shaman.sql`).
- Created `RecipientNotificationUseCase` (`src/use-cases/implementations/recipientNotification.useCase.ts`) with `dispatchP2PSend` and `flushPendingForTelegramUser` methods.
- Threaded `recipientTelegramUserId` and `recipientHandle` from `SendCapability` state through `sign_calldata` artifact → `SigningRequestRecord` → `SigningResolutionEvent` → `buildNotifyResolved`.
- `buildNotifyResolved` calls `dispatchP2PSend` best-effort (wrapped in try/catch) on every successful p2p send.
- `TelegramAssistantHandler` flushes pending notifications for the recipient on `/start` and on `handleWebAppData` auth success.
- `getRecipientNotificationUseCase(send)` added to `AssistantInject` DI container.
- Both `telegramCli.ts` and `workerCli.ts` wire up the use case.

**Why this approach:**
- Live delivery uses `telegramSessions.findByChatId(telegramUserId)` since for Telegram DMs `chatId === userId` numerically — no schema change required.
- Deferred delivery (recipient not yet onboarded) is persisted as `status='pending'` and flushed on first `/start`, preserving the "while you were away…" onboarding moment.
- Dispatch is always best-effort and never blocks the sender's success reply.

**New conventions:**
- Any future "external party should know about a thing that happened to them" feature should reuse `RecipientNotificationUseCase` rather than rolling its own pathway.
- The log scope `recipientNotificationUseCase` uses metadata field `id` = notification row PK.
- `senderHandle` is currently always `null` (sender's Telegram username is not available at dispatch time). This is v1 acceptable — the message falls back to "someone". Future improvement: thread sender username through `CapabilityCtx.meta`.
