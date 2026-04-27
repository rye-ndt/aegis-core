# Capabilities Status

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
