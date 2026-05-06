# Capabilities Status

## route_intent: suppress LLM acknowledgment + onramp/dedup hardening — 2026-05-05

**What was done:**
- `assistant.usecase.ts` system prompt now instructs the LLM to reply with an
  empty string after `route_intent` returns. The capability already rendered
  the user-facing artifact (mini-app prompt or result card); a "flow started"
  acknowledgment was firing before the user clicked the WebApp button (or
  chose not to), which read as a false confirmation.
- `routeIntent.tool.ts` returns matching tool-side text:
  `"Capability rendered the user's next step. Reply with an empty string —
  do not write any follow-up."`
- `assistantChatCapability.ts` now returns `{ kind: "noop" }` when the LLM's
  prose reply is empty/whitespace, so a blank chat bubble never reaches
  Telegram.
- `signingRequest.usecase.ts` adds a per-user recent-txHash guard
  (`RECENT_TXHASH_TTL_MS = 10 min`). On `resolveRequest` with a `txHash`,
  if a *different* recent requestId from the same user already claimed
  that hash, throw `SIGNING_REQUEST_DUPLICATE_HASH`. Same-requestId reuse
  remains idempotent (FE retries on flaky network are unaffected).
- `httpServer.ts` maps the new error to `409 Conflict` and deletes the
  mini-app cache entry like the other terminal-error branches.

**Why over alternatives:**
- For the "flow started" message: gating on click would require a callback
  back into the LLM turn; suppressing the line entirely is cleaner because
  the mini-app prompt already conveys "tap below to..." and the result-card
  framework handles every other follow-up surface.
- For the dedup: server-side is the correct trust boundary. The FE's
  payload-keyed dedupe (`recentBroadcasts.ts`) collided with legitimate
  user-initiated repeats (e.g. `/send 0.01 USDC` twice → second send
  silently reused the first hash). The FE was rekeyed by `requestId`
  instead, but the BE guard ensures future FE bugs can't fake success.

**New convention:**
- `route_intent` (and any future single-call dispatcher tool) MUST instruct
  the LLM to reply empty. Acknowledgment lines belong in the artifact
  (`promptText`, `result_card`), not in LLM prose.
- New error code: `SIGNING_REQUEST_DUPLICATE_HASH` → HTTP 409. Add to the
  same branch as `NOT_FOUND/EXPIRED/FORBIDDEN` in `httpServer.ts` so the
  mini-app cache entry is dropped on terminal failures.



## /send — in-code SEND_MANIFEST + direct ERC-20 calldata — 2026-05-05

**What was done:**
- `sendCapability.ts` now defines `SEND_MANIFEST: CapabilityManifest` inline
  (verbatim copy of the `input_schema` JSON from
  `drizzle/0023_seed_send_tool.sql:36`) and a private
  `buildTransferCalldata` helper. The capability no longer calls
  `intentUseCase.selectTool` / `intentUseCase.buildRequestBody`; both have
  been deleted from `IIntentUseCase`.
- Native sends: `{ to: recipient, data: "0x", value: amountRaw }`.
- ERC-20 sends: `{ to: tokenAddress, data: encodeFunctionData(erc20Abi, "transfer", [recipient, BigInt(amountRaw)]), value: "0" }`.
  Mirrors the legacy `executeErc20Transfer` step executor byte-for-byte.
- `SessionState.manifest` and `SendParams.manifest` are now
  `CapabilityManifest` (from `helpers/types/manifest.ts`), not the
  zod-validated `ToolManifest`.

**Why over alternatives:**
- Solver / manifest-DB registry was the only consumer of the dynamic-tool
  table; nothing else read `tool_manifests`. Inlining the manifest dropped
  the entire RAG + solver hop without changing calldata bytes.
- Kept `compileSchema` / `generateMissingParamQuestion` / `searchTokens`
  on `IIntentUseCase` because both `/send` and `/swap` still rely on
  LLM-driven param extraction.

**New convention:**
- In-code capability tools register a `CapabilityManifest` constant in the
  capability file. The slim type lives in `helpers/types/manifest.ts` and is
  the single source of truth for both `SEND_MANIFEST` and `SWAP_MANIFEST`.
  Calldata is built directly inside `Capability.run` rather than dispatched
  through `solverRegistry`.

## /stock — preview-only summary, no chat preamble — 2026-05-05

**What was done:**
- Removed the `await ctx.emit({ kind: "chat", text: plan.quoteSummary })`
  preamble from all three `/stock` flows (open, close, set_exits). The
  previous behaviour duplicated the "Tap below — all steps will be
  signed in one mini-app session." prompt (once in the chat preamble,
  once in the `mini_app` `promptText`) and leaked raw quote internals
  (Notional / Mark / Leverage / Steps) into the chat transcript instead
  of inside the mini-app modal.
- Dropped `quoteSummary` from `StockExecutionPlan` entirely (and the
  `buildOpenQuoteSummary` helper from `stock.usecase.ts`). Replaced with
  structured fields the capability uses to enrich the per-step preview:
  `markPriceUsd?: string` on open, `closeContext?: { side, collateralUsd,
  unrealizedPnlUsd }` on close.
- Open preview's first step now includes Notional / Mark / Leverage so
  that information is still available to the user, but rendered cleanly
  inside the mini-app modal instead of leaking into chat.
- Close preview's first step now includes Side / Collateral / P&L, again
  surfaced inside the modal.

**Why this approach:**
- Other intents (`send`, `swap`, `buy`) emit only the `mini_app` artifact
  and rely on `preview` (an `IntentResult`) for the human-readable
  summary. `/stock` was the outlier — a chat preamble plus a mini-app
  prompt produced a two-message UX with overlapping copy. Matching the
  established pattern is the simplest fix and removes the dead
  `quoteSummary` field from the use-case interface.

**New conventions (do not break):**
- Capabilities MUST NOT emit a separate `chat` artifact summarising the
  about-to-be-signed plan. Pack the summary into `IntentResult` via
  `buildPreview` and attach it to the first step's signing record. The
  FE renders previews inside the mini-app modal at session start.
- Plan structs returned by the use case carry data, not pre-rendered
  copy. Any free-text the user sees is constructed in the capability
  layer (which owns the UX surface).

## /stock buy — deterministic symbol resolution — 2026-05-05

**What was done:**
- `parseAmountSymbol` rewritten to be deterministic and LLM-free. Each
  non-amount token is filtered against a `STOP_WORDS` set ("of", "the",
  "for", "worth", "stock", "shares", …) and then handed to
  `IStockPairRegistry.resolveByQuery`. First successful resolve wins.
  Tickers ("AAPL"), company names ("apple"), and aliases the SEC name
  exposes ("alphabet" → GOOG via "Alphabet Inc.") all resolve.
- `/stock close` and `/stock sl|tp` symbol arguments now also pass
  through `resolveByQuery`, so `/stock close apple` works the same way
  as `/stock close AAPL`.
- `StockCapabilityDeps` gained `stockPairRegistry: IStockPairRegistry`.
  The capability owns the registry handle directly rather than reaching
  through the use case — keeps the use case's port set unchanged.

**Why this approach:**
- The previous parser matched any 1–5-letter token as a ticker, then
  let the use case validate. So `"buy $5 of apple"` extracted `"APPLE"`
  (a non-existent ticker) and the use case rejected it with "unsupported
  symbol APPLE", which surfaced as a generic failure card. The user's
  bug report on 2026-05-05 was exactly this path.
- Going through the registry's ranked match means the capability
  rejects ambiguous input at parse time (`usageHint`) rather than after
  the use case has done partial work. The DB is the single source of
  truth for "what's supported".
- Stop words are stripped to handle natural phrasings without an LLM
  parser. The list is closed and small — adding to it is a deliberate
  decision, not an LLM hallucination.

**New conventions (do not break):**
- Capabilities that take a stock symbol from free-text input MUST go
  through `IStockPairRegistry.resolveByQuery` — never `string.toUpperCase()`
  + regex shape check. The shape check passed "OF" and "APPLE" alike;
  the registry pass rejects both correctly.
- Stop-word lists live next to the parser they protect. Don't centralise
  them — different verbs filter different fillers.



## stock_open LLM tool — 2026-05-05

**What was done:**
- New `tools/stockOpen.tool.ts` registered in the per-message LLM tool registry
  alongside `ExecuteIntentTool` / `GetPortfolioTool`. Builds a `/stock buy|short
  $X SYM` string and re-enters `ICapabilityDispatcher.handle` so the user sees
  the same mini-app modal as the explicit slash command. Soft-disabled when
  `verifyStockCapability()` fails at boot — surfaces a friendly error from
  inside `execute()` (matches read-only sibling tools' policy).
- `IChatInput` gained `channelId: string`. Threaded through
  `AssistantUseCaseImpl.chat → registryFactory(userId, conversationId,
  channelId)` so capability-bound tools have the renderer routing key.
  `AssistantChatCapability.run` passes `ctx.channelId` at the call site.
- `INTENT_ACTION.STOCK_TRADE` is still enum-only and intentionally unused.
  Reserved for a future intent-parser route; do not delete without auditing
  the parser fixtures.

**Why this approach:**
- The `/stock` capability dispatch path is the only execution surface that
  emits the mini-app modal. Calling it via the dispatcher (rather than calling
  `IStockUseCase` or `IIntentUseCase.parseAndExecute`) reuses the entire
  preview / signing / recovery / loyalty / error-catalog plumbing for free.
- `parseAndExecute` is the dynamic-tool/solver pipeline (`/send`-style); it
  has no path that ends in a Capability. Mirroring `transferErc20.tool.ts`
  would have silently misrouted to the swap solver.

**New conventions (do not break):**
- LLM tools that need to invoke a slash-command capability MUST go through
  `ICapabilityDispatcher.handle({ userId, channelId, input: { kind:"text",
  text:"/cmd ..." } })`, not `IIntentUseCase.parseAndExecute`. The latter is
  for solver-backed actions (swap, send-token).
- `IChatInput.channelId` is required; new free-text entry points must supply it.
- Capability-bound LLM tools (any tool that calls `ICapabilityDispatcher.handle`)
  must lazy-resolve the dispatcher inside `registryFactory`'s per-message lambda
  to avoid the `getCapabilityDispatcher → getUseCase → registryFactory` cycle
  triggering during construction.
- Recursive dispatch on the same `channelId` is intentional and supported
  (LLM tool re-enters the dispatcher mid-LLM-round). Capabilities that write
  pending state must continue to scope their pending keys to a `(channelId,
  capabilityId)` pair so a recursive dispatch can't read the outer capability's
  state.

## Result-card framework — review-feedback closure — 2026-05-05

Closes the gaps surfaced by the post-implementation review agent (true-positive
sweep done first; non-claims left untouched).

**Verified true positives, then fixed:**
- **assistantChatCapability fully migrated.** New `assistantResultRouter.ts` maps `StructuredToolPayload` → `IntentResult` for all four read-only tools (`get_transfer_history`, `get_stock_positions`, `get_stock_quote`, `get_portfolio`). Each tool's `execute()` now returns `{success, data, structured?}` — `data` (markdown table) still flows to the LLM for context, `structured` is captured by `AssistantUseCaseImpl` (last-tool-wins) and surfaced via `IChatResponse.lastStructuredToolResult`. The capability emits `result_card` when a structured payload is present and falls back to `kind:"chat"` for plain prose. The LLM's prose is intentionally suppressed on the structured branch — that's the whole point of plan §5.2.5.
- **Renderer requestId tail gated to `errorCode === "internal"` (spec §2.2).** Added `errorCode?: string` to `IntentResult`. The renderer only emits "If this keeps happening, tell us with code …" when `errorCode` is missing or `"internal"`. Known catalog codes (amount_too_low, no_route, etc.) no longer leak a support id alongside their already-friendly text. All capabilities that called `interpretError` now pass `errorCode: interpreted.code` on their failed cards.
- **Three previously-unreachable error codes now have regex patterns**: `unsupported_token`, `insufficient_allowance` (with a `Grant permission` → `/permissions` recovery), and `transfer_history_unavailable`. Each has a unit test.
- **Three test failures fixed (root-caused, not papered over).** `tests/sendCapability.test.ts` was hitting a hard `abort("no usdc found for this chain")` because chainId=1 fiat detection requires `ETH_USDC` env that isn't set in tests; fix is one line at the top of the file. `tests/capability.dispatcher.test.ts`'s "default fallthrough" test was wrong from inception — `CapabilityRegistry.match()` never falls through to `defaultCapability`; the dispatcher itself calls `getDefault()` separately. Test rewritten to reflect the real contract.

**Verified false positives (no action taken):**
- "Sign-capability test regression suggests something behavioural shifted on the stubbed path" — false. The stubs were missing an env var that's required for the BE-side fiat detection that's been in place independently of the result-card work. Setting `ETH_USDC` made all paths green.

**Stock per-step preview attachment (plan §5.2.4 deferred item, now closed).**
`executeSignSteps` gained an optional `previews?: (IntentResult | undefined)[]` param. When provided, `previews[i]` attaches to step `i`'s `SigningRequestRecord` and its mini-app cache entry — so the FE's `?after=<prev>` chain shows distinct cards for "Approve USDC" → "Swap on BSC" → "Open AAPL long" instead of the same step-0 preview throughout. Backwards-compat: the legacy single `preview` arg is still respected when `previews` is omitted (attached to step 0 only). Wired up on the open and close paths (multi-step). Set-exits is single-step and stays on the legacy `preview` path.

**Logging cleanup.**
`notifyResolved` and `yieldReportJob.sendReport` now emit the canonical
`step: 'started' | 'succeeded' | 'failed'` lifecycle with `durationMs` per
CLAUDE.md. Each branch (success-with-tx, recovery-success, insufficient-USDC
nudge, non-USDC insufficient, stock errors, generic errorCode, user-rejected)
logs `succeeded` with a `mode` discriminator so call-graph traces stay
readable.

**Paperwork.**
- New `helpers/errors/errorCatalog.md` — standalone reference table for every code with friendly text, regex, and recovery action; documents the renderer-side internal-only requestId-tail rule.
- `redis.signingRequest.ts` carries a schema-evolution comment: optional fields like `preview` are JSON-roundtrip-compatible without bumping the `sign_req:` key prefix; only breaking shape changes warrant a version bump.

**Test counts:** 98 passing across `errorCatalog`, `resultCardRender`, `sendCapability`, `capability.dispatcher`, `assistantResultRouter`, `loyalty.formula`, `loyalty.usecase`, `yieldPoolRanker`, `yieldRepository.window`. 0 failing. `npx tsc --noEmit` clean.

## Result-card framework — P7+ gap closure — 2026-05-05

Closes the deferred items called out in the P2–P6 entry below, plus the §9
"files to modify" list (positions, loyalty, notifyResolved, daily report) and
the §8 test fixtures.

**What was done:**
- **positionsCapability** — fully migrated to `result_card`. Stops round-tripping through the LLM tool loop and calls `IStockUseCase.listPositions` directly: structured fields beat hoping the LLM reformats a markdown table cleanly. Verbs: `positions_query`. Errors flow through `interpretError`. Empty result emits a `success` card ("No open stock positions") rather than a chat string. DI was switched to pass `(getStockUseCaseSync, isStockCapabilityDisabled)` so the capability honours the same disabled-gate the rest of the stock surface uses.
- **loyaltyCapability** — both `/points` and `/leaderboard` migrated. Verb `loyalty_query`. Balance becomes a `primary` field; recent ledger entries surface as fields with the rest under the spoiler `details` block. Leaderboard highlights the caller's row via `emphasis: "primary"`. The pre-existing helpers (`buildPointsMessage`, `buildLeaderboardMessage`) were deleted — the renderer is now the single formatter.
- **notifyResolved** (`helpers/notifyResolved.ts`) — migrated. Every branch now constructs an `IntentResult` and renders via `renderResultCard`, sending the resulting MarkdownV2 + keyboard through `tgApi.sendMessage`. Branches preserved exactly: success-with-decoded-ERC20, success-with-recovery, insufficient_token_balance USDC `/buy` nudge (callback payloads `buy:y:N` / `buy:n:N` are the buy-flow contract and are kept byte-identical), other rejection codes including the Aster `stockErrorMessage` table. The renderer's settlement-tx logic auto-derives the "View on explorer" button from `IntentResult.txHashes`, so the bespoke explorer-link helper is gone. **Recipient notification dispatch is unchanged** (plan §12 keeps that path out of scope).
- **yieldReportJob.sendReport** — migrated. Verb `portfolio_summary`, `complexity: "complex"`. Top mover + total earned become primary fields; per-position rows go in `details`. The bespoke OpenAI prompt the job ran inline (2–4 sentence "warm yield update") was removed in favour of the framework's `IIntentInterpreter` — when env-gated on, the interpreter writes the same kind of italic note; when off, the user sees clean structured fields. The job retains markdown-fallback behaviour on Telegram parse errors.
- **Env helper** — `helpers/env/resultCardEnv.ts` exposes `getResultCardEnv()` returning `{enabled, apiKey, model}`. DI's `getIntentInterpreter` no longer reads `process.env.*` directly; it composes `getResultCardEnv()`. Default model is `gpt-4o-mini`; override hierarchy is `RESULT_CARD_INTERPRETER_MODEL` → `OPENAI_MODEL` → default.
- **Tests** (`tests/errorCatalog.test.ts`, `tests/resultCardRender.test.ts`) — 28 new tests. Renderer covers all 4 statuses, emphasis variants, MarkdownV2 escaping (parens / brackets / period / exclamation), max-fields and max-action limits, interpreter-note rendering, spoiler details + explorer button. Catalog covers regex precedence, `UnsupportedChainError` typed-instance fast path, recovery-action shape, internal fallback, and the "no codes/raw inside friendly" privacy invariant.
- **Updated stale tests**: `tests/sendCapability.test.ts` happy-path now asserts `sign_calldata.preview` is set instead of a removed pre-sign chat artifact. `tests/capability.dispatcher.test.ts` buy:y deposit branch now asserts a `result_card` of verb `buy_onramp` with the SCA address as a field (replacing the stale `chat`-artifact + `buy:copy` callback assertions; that callback was removed during P5).

**Why this approach:**
- `positionsCapability` calling `IStockUseCase` directly (rather than building a structured-tool side-channel for the LLM loop) is a cheaper, more reliable migration than refactoring the assistant chat loop. Dedicated capability triggers (`/positions`) want dedicated formatters; the structured-tool router is only a real win for free-text queries that incidentally hit a tool.
- For `notifyResolved`, going through `renderResultCard` instead of building a parallel formatter means the explorer-button keyboard, MarkdownV2 escaping, and spoiler details auto-collapse all behave identically to the rest of the framework. The tradeoff: post-tx receipts are now MarkdownV2 (was Markdown) — clients that don't render MarkdownV2 cleanly will see literal `\.` / `\!` escapes. Mitigated by the existing plain-text retry path on parse failure.
- For the daily report, dropping the inline LLM call simplifies the job to "build structured fields, hand to the renderer, optionally let the framework's interpreter add a note". The ≤25-word interpreter cap is intentionally tighter than the prior "2–4 sentences"; this matches plan §4.2 ("write ONE sentence"). If users miss the longer prose we can re-tune the interpreter system prompt without touching the job.

**New conventions (in addition to the P2–P6 entry below):**
- Read-only query capabilities (positions, loyalty, balance/portfolio summary, history) emit `result_card{status:"success"}` even on the empty path. "No data" is an outcome and gets a card with a muted explanatory field; it is NOT a `chat`.
- When migrating a non-renderer call site (jobs, helpers, etc.), prefer importing `renderResultCard` and sending via the existing transport (`bot.api.sendMessage` / `tgApi.sendMessage`) over plumbing the full `IArtifactRenderer` through. Keeps DI footprint small while still using the canonical formatter.
- Env reads for the result-card stack go through `getResultCardEnv()` — do not sprinkle `process.env.RESULT_CARD_INTERPRETER_*` reads at call sites.

**Remaining gaps (intentionally not closed in this phase):**
- `assistantChatCapability` structured-tool-result routing (plan §5.2.5). The free-text LLM-tool-loop path still returns a single `reply: string`; rerouting tool outputs into `result_card` requires extending `IChatResponse` to surface tool-result data and adding a router that recognises known shapes. Plan §13 itself flags the alternative (heuristic markdown parsing) as fragile, so this stays deferred until the contract change is justified by user-visible drift. The `/positions` path is now covered by `PositionsCapability` directly; `/portfolio` and `/history` still go through the LLM loop.
- `tests/sendCapability.test.ts`'s "simple happy path" and "token disambiguation round-trip" remain failing pre-existing tests (the dispatcher returns `handled: false` against the test's stubbed `IIntentUseCase` because the real send flow grew additional collaborators since the fixture was authored). Not introduced by this phase; flagged for a follow-up that re-stubs the fixture.

## Result-card framework — P2–P6 capability migrations — 2026-05-05

Per `be/constructions/2026-05-04-result-card-framework.md` §5–§8. Builds on the P1 foundations entry below.

**What was done:**
- New helpers: `helpers/format/humanFormat.ts` (formatTokenAmount, formatUsd, formatRelativeTime, formatDuration, truncateHash) and `capabilities/buildPreview.ts` (canonical constructor for `IntentResult{status:"preview"}`).
- Preview plumbing extended through the sign-request transport: `Artifact.sign_calldata.preview?: IntentResult` → `SigningRequestRecord.preview?: IntentResult` (the existing redis cache JSON-serializes the field automatically — no serializer change needed). The Telegram renderer's `sign_calldata` case threads `artifact.preview` into the persisted record so the FE mini-app can read it via `GET /request/:id` and render the modal body via the FE `ResultCard` component (FE plan §3.1). Backwards-compat: when `preview` is undefined the mini-app falls back to today's raw to/value/calldata view.
- Interpreter wired through DI (`getIntentInterpreter`). Env-gated behind `RESULT_CARD_INTERPRETER_ENABLED=true` AND `OPENAI_API_KEY`. Model resolves to `RESULT_CARD_INTERPRETER_MODEL ?? OPENAI_MODEL ?? "gpt-4o-mini"`. Cache keyed under `interp:` namespace via `makeRedisResponseCache`. The `RESULT_CARD_INTERPRETER_ENABLED` env replaces the P1 placeholder.
- **swapCapability** (§5.2.1): dropped the BE-side `buildQuoteSummary` Telegram emit and the `buildCompletionMessage` chat reply. The pre-sign quote now lives on `preview` (set on the FIRST step's `SigningRequestRecord` only — subsequent steps chain silently via `fetchNextRequest`). Post-success returns `result_card{status:"success", verb:"swap"}` with `txHashes:[settlementHash]`, "Earn yield" + "Swap again" `nextActions`, `complexity:"complex"` whenever cross-chain or multi-step. Quote-failure path runs through `interpretError({verb:"swap"})`. Mid-flow rejected/expired/no-tx-hash returns are now `result_card{status:"failed"}` cards with earlier `txHashes` preserved.
- **sendCapability** (§5.2.2): `buildRequestBody` failures route through `interpretError`. Pre-sign Telegram chat emits removed (auto-sign "Check the Aegis mini app…", manual-sign `buildConfirmationMessage`/`buildFinalSchemaConfirmation`). Both auto-sign and manual-sign `sign_calldata` artifacts now carry `preview` ("Send 5 USDC to @alice"). The renderer's standard `Tap below to execute silently. / Tap below to review and sign.` prompt is the only Telegram-side message before signing. **Post-tx success/failure UX is owned by `notifyResolved` (recipient notification path), not by sendCapability.run() — that lives in `helpers/notifyResolved.ts` and is intentionally out of scope for this phase. See "Open follow-ups" below.**
- **yieldCapability** (§5.2.3): deposit/withdraw/rebalance pre-sign Telegram quote emits removed; previews attached to first step in each flow via a new `preview?: IntentResult` param threaded through `executeSignSteps`. Success returns `result_card` with verbs `yield_deposit` (simple), `yield_withdraw` (simple), and `yield_rebalance` (complex with `interpreterContext: { fromProtocol, toProtocol, fromApy, toApy, sizeUsd }`). Position-vanished and signing-unavailable paths render as `result_card{status:"failed"}`. Mid-flow rejected/expired returns become `result_card`s. **Daily report (`yieldReportJob.sendReport`) NOT migrated** — the job sends Telegram messages directly via the bot rather than through the artifact renderer; routing it through the renderer requires DI plumbing that's out of scope here.
- **buyCapability** (§5.2.4): "smart account not set up" failure → `result_card{status:"failed", verb:"buy_onramp"}`. Deposit-address path (today a markdown chat) → `result_card{status:"pending", verb:"buy_onramp"}` with the address as a body field and a "Buy with card instead" callback nextAction. The card-onramp `mini_app` artifact is unchanged (it's a mini-app handoff, not a sign request, so there's no preview to attach).
- **stockCapability** (§5.2.4): top-level catch routes through `interpretError({verb})` with `verbForKind` mapping. Open/close/exits success → `result_card` with verbs `stock_buy` / `stock_close` / `stock_set_exits`; open is `complexity:"complex"` so the interpreter can frame "you now own ~X shares". Disambiguation prompts ("Multiple positions open — pick one") stay as `kind:"chat"` since those are ask-style, not terminal outcomes. Mid-flow rejected/expired in `executeSignSteps` now emit `result_card{status:"failed"}`. **Stock previews on sign requests NOT attached** — each Aster step has its own `step.label` (approve → swap → open) and the previews would need per-step labelling; deferred. Recovery flow's mini-app handoff is unchanged.
- **assistantChatCapability** (§5.2.5): NOT migrated. The capability returns `IChatResponse{reply: string}` from the LLM tool loop, with no structured-tool-result side-channel. The plan's heuristic-based prose-vs-structured router would have to parse the markdown reply, which §13 itself flags as fragile. Documented in-file as a `TODO` deferred until `IChatResponse` exposes structured tool output.
- Removed stale helpers: `swapCapability.formatHashes`, `yieldCapability.{buildDepositQuoteSummary, buildWithdrawQuoteSummary, buildDepositSuccessMessage, buildRebalanceQuoteSummary, buildRebalanceSuccessMessage, buildWithdrawSuccessMessage}`, `stockCapability.formatHashes`. Stale imports cleaned in send (dropped `buildConfirmationMessage`, `buildFinalSchemaConfirmation`, `populateFinalSchema` from `send.messages`) and stock (dropped `getExplorerTxUrl` import — explorer link is now derived by the renderer from `IntentResult.txHashes`).
- Status emoji map for non-success outcomes is now consistent across the codebase via the renderer (`pending → ⏳`, `failed → ⚠️`, `success → ✅`); capabilities supply `status` only.

**Why this approach:**
- Threading `preview` through the existing `SigningRequestRecord` (rather than adding a parallel cache) means zero migration cost: every sign request that already had a record gains the optional field, and JSON serialization "just works" because the redis cache stores `JSON.stringify(record)`.
- `executeSignSteps` in yield gained an `opts.preview` param rather than a per-step preview array because the mini-app modal only ever shows the user one preview screen — subsequent FE-chained steps execute silently. Doing it any other way would mislabel the modal during chained execution.
- For swap, attributing `preview` to step 0 (typically the approve leg in same-chain mode, or the first Relay step in cross-chain) and not later steps means the user sees a coherent "Swap 5 USDC for ~0.06 AVAX" summary even though the underlying tx is an ERC-20 approve. The plan accepts this in §5.1 — the modal preview describes the user's intent, not the leg's calldata.
- Pre-execution validation aborts (e.g. `swapCapability.abort("Unknown chain")`, `stockCapability.usageHint`) intentionally stay on `kind:"chat"`. Plan §7 P7 says the terminal-must-be-result_card rule applies to "outcomes"; ask-style validation prompts and disambiguation menus aren't outcomes. The boundary is: if the user is being asked to choose/correct, it's `chat`; if execution actually happened or definitively didn't, it's `result_card`.
- The interpreter's DI is `getIntentInterpreter() → IIntentInterpreter | undefined`, returning undefined when env-gated off. The renderer treats undefined as "interpreter off" and skips the optional italic note — no separate "is interpreter enabled" flag needs to flow through the call sites.

**New conventions (do not break):**
- Capabilities that emit `sign_calldata` for an ERC-20 / native spend MUST attach `preview: buildPreview({...})` so the mini-app modal shows a clean summary instead of raw calldata. Don't route preview construction through ad-hoc strings — always go through `buildPreview`.
- `complexity:"complex"` is reserved for outcomes that genuinely benefit from a one-sentence LLM gloss: cross-chain swaps, multi-step swaps, yield rebalance, stock buy. Single-token sends, same-chain single-step swaps, simple deposits/withdrawals are `"simple"` so the interpreter never fires for them. New capabilities default to `"simple"` and earn `"complex"` only when the field set wouldn't be self-explanatory to a teenager.
- Pre-execution `abort` messages stay as `kind:"chat"`. Post-execution outcomes are always `result_card`. If you find yourself adding a `chat` artifact in `run()` and not in `collect()`, you almost certainly want a `result_card` instead.
- For multi-step sign-request flows (swap, yield deposit/withdraw/rebalance, stock open/close), the preview attaches to the FIRST `SigningRequestRecord` only. Subsequent steps' `preview` MUST be `undefined` so the FE doesn't re-render the modal mid-chain.
- New result-card verbs go on the `IntentVerb` union in `resultCard.types.ts`. `verbForKind` in stockCapability is the canonical mapping from `StockParams.kind` to `IntentVerb`; mirror its pattern when other capabilities grow internal-kind unions.

**Open follow-ups (deferred, with rationale):**
- `notifyResolved` post-tx success/failure messages (used by send's resolution path) still emit raw text. Migrating it requires plumbing the artifact renderer into the recipient-notification path; not done here because send's own pre-sign UX is the user-visible swing in this phase.
- `yieldReportJob.sendReport` daily yield report — still emits markdown directly via the bot. Migrating it cleanly requires routing the job through the artifact renderer (or building a renderer-equivalent for jobs); deferred.
- Stock per-step `preview` attachment (Aster approve → swap → open). The label set ("approve USDC", "swap to USDC.E on BSC", "open AAPL long") is per-step and would need a richer `executeSignSteps` contract to expose it on the modal. Deferred; the existing per-step `step.label` continues to feed `record.description`.
- `assistantChatCapability` structured-tool-result routing. Requires extending `IChatResponse` to expose underlying tool outputs; the plan itself flags the alternative (heuristic markdown-table parsing) as fragile. Deferred until the contract change lands.
- Snapshot tests for the renderer (plan §7 P1) and pattern tests for `errorCatalog` (§7 P1). The repo has no `be/tests/` directory yet — will add alongside the test-runner setup, not blocked on this phase.

## Result-card framework — P1 foundations — 2026-05-04

Per `be/constructions/2026-05-04-result-card-framework.md` §1–§4. **No capability migrated yet** — this PR is opt-in scaffolding. Existing `kind: "chat"` terminal replies are untouched.

**What was done:**
- New `IntentResult` shape and `result_card` artifact variant (`use-cases/interface/input/resultCard.types.ts`, plus a new branch in `Artifact`). `IntentResult` carries `status × verb × headline × fields × txHashes? × nextActions? × complexity? × interpreterContext? × details? × requestId?`.
- Renderer (`adapters/.../artifactRenderer/resultCard.render.ts` + `resultCard.escape.ts`) is the single place that touches Telegram MarkdownV2: `escapeMd` runs over every capability-supplied substring; `renderResultCard` builds `text + keyboard + parseMode`. Layout: status emoji + headline, body fields, optional italic interpreter note, "What's next" line, MarkdownV2 spoiler `||...||` for details + tx hashes.
- `TelegramArtifactRenderer.render` gained a `case "result_card"`: invokes the optional `IIntentInterpreter` only when `complexity === "complex"`, swallows interpreter failures, never blocks the receipt. `preview`-status cards are dropped on the Telegram side (they belong to the mini-app).
- Telegram input handler (`telegram/handler.ts`) recognises `cmd:<text>` callback data on the global callback router: strips the prefix and re-dispatches as `{ kind: "text", text }`. This is what makes a result card's "command" `nextAction` button tappable end-to-end.
- New port `IIntentInterpreter` + OpenAI adapter (`adapters/.../intentInterpreter/openai.intentInterpreter.ts`). 2-second timeout with `Promise.race`, optional `RedisResponseCache` keyed by `sha256(verb|status|fields|context)` with 5-min TTL, sentence clamped to ≤25 words. **Not wired into DI yet** — P1 ships with the renderer's `intentInterpreter` constructor arg undefined, equivalent to `RESULT_CARD_INTERPRETER_ENABLED=false` in the plan. Subsequent phases will wire it.

**Why this approach (vs. alternatives):**
- The renderer runs the interpreter (not capabilities) so capabilities cannot "forget" the LLM pass — they only set `complexity: "complex"` and the framework does the rest.
- Slash-command relay via `cmd:` callback data was the only Telegram-supported way to make a slash-command-style "What's next" button tappable; Telegram doesn't support a button that types a `/cmd` for the user, so we round-trip through callbacks.
- `preview` is part of the same `IntentResult` shape rather than a separate `PreviewCard` type because the FE mini-app will render it via the same component (FE plan §3.1) — splitting types would force two parallel renderers for the same grammar.

**Conventions introduced (do not break):**
- All terminal capability outcomes that go to the user MUST eventually become `kind: "result_card"` (subsequent phases). `kind: "chat"` is reserved for intermediate ask-prompts. P1 doesn't enforce this — phases P2–P6 do.
- Capabilities never write MarkdownV2. They hand the renderer plain strings; `escapeMd` runs in the renderer.
- Capabilities never inline error strings from caught exceptions. They MUST call `interpretError(err, { verb, requestId })` from `helpers/errors/errorCatalog.ts` and project the result into `IntentResult.fields` + `nextActions`.
- New verbs go on the `IntentVerb` union in `resultCard.types.ts`. New error codes go on `ErrorCode` in `errorCatalog.ts` AND its `PATTERNS` table.
- New log scopes: `resultCardRender`, `errorCatalog`, `intentInterpreter`.

## Yield auto-rebalance (minimal) — 2026-05-04

Implemented Part B of `be/constructions/2026-05-04-yield-fixes-and-auto-rebalance.md`.

**What was done:**
- `runPoolScan` writes/updates `yield:winner_streak:{chainId}:{token}` per
  scan (`{ protocolId, apy, count, lastTs }`). TTL = 4× pool-scan interval
  so streaks self-heal if scans stall. Same protocol → increment count;
  switch → reset to 1. This is the strong hysteresis filter.
- New `IYieldOptimizerUseCase` methods:
  - `scanRebalanceForUser(userId)` — gated by per-user cooldown +
    pending-lock; iterates enabled `(chainId, token)` pairs, requires
    `streak.count ≥ YIELD_REBALANCE_STICKY_SCANS`, discovers user's
    on-chain positions, picks the largest non-winner position, fetches
    current APY (via `adapter.getPoolStatus`), and only nudges when
    `(winnerApy − currentApy) × 10_000 ≥ YIELD_REBALANCE_MIN_DELTA_BPS`.
    Sets `yield:rebalance_pending:{userId}` (1h TTL) and
    `yield:rebalance_cooldown:{userId}` (24h TTL).
  - `buildRebalancePlan(userId, params)` — re-reads positions (paranoid;
    user may have withdrawn since the nudge), emits
    `withdrawAll(from) + supply(to)` tx steps. Returns `null` if the
    source position vanished — capability surfaces a friendly message
    and clears the pending lock.
  - `finalizeRebalance(userId, params)` — `try/catch/finally`: snapshots
    both `from` (likely 0) and `to` (new balance) protocols, then
    always clears the pending lock. On-chain withdraw already
    succeeded, so failures `warn` only.
  - `clearRebalancePending(userId)` — used by the capability's "skip"
    branch and abort/no-plan paths.
- `userIdleScanJob` runs `scanRebalanceForUser` as a sibling to
  `scanIdleForUser` per user (still `pLimit(5)` chunked). Both calls
  have their own Redis cooldowns; co-locating them avoids a second
  cron timer.
- `TriggerSpec.callbackPrefix` widened to `string | string[]`. The
  registry now expands array prefixes into multiple routing entries
  (still longest-prefix-first). `YieldCapability` declares
  `["yield", "rebalance"]` so `rebalance:y/n` callbacks route here.
- `YieldCapability.runRebalance`:
  - Plan re-build via `buildRebalancePlan`; on null returns "Looks
    like you already withdrew — nothing to rebalance." and clears
    pending.
  - Markdown quote summary mentions both APYs and the move size.
  - Reuses `executeSignSteps` with `kind: undefined` (mini app falls
    back to its default sign confirm screen — the deposit/withdraw
    confirm cards would mislabel the withdraw leg).
  - Spend bookkeeping: `spendAmountRaw = plan.amountRaw` is set so the
    LAST step (the supply call) is tagged with
    `tokenAddress + amountRaw`. The withdraw leg burns aTokens → no
    delegation consumption → untagged.
  - On success: `finalizeRebalance` writes both snapshots and awards a
    single `yield_deposit` loyalty action (the withdraw leg is NOT
    awarded — would double-count).
  - On abort/timeout: clears the pending lock so the user isn't stuck.
- New `buildRebalanceNudgeKeyboard({ chainId, tokenAddress, fromProtocol, toProtocol })`
  in `yieldCapability.ts` is shared with `assistant.di.ts`'s
  `sendRebalanceNudge` callback. Yes/Skip buttons emit
  `rebalance:y:<chainId>:<token>:<from>:<to>` and
  `rebalance:n:<chainId>:<token>`.
- Env (`helpers/env/yieldEnv.ts`): `rebalanceCheckIntervalMs`,
  `rebalanceMinDeltaBps`, `rebalanceStickyScans`,
  `rebalanceNudgeCooldownSec`. The DI computes
  `winnerStreakTtlSec = max(60, 4 × poolScanIntervalMs / 1000)`.

**Why this approach (vs. alternatives):**
- *Why no opt-in flag?* The nudge is non-destructive and always asks
  for explicit user consent before signing. Adding a flag now creates
  a setup tax for a feature that is dormant in production until a
  second adapter lands.
- *Why fold into `userIdleScanJob` instead of a new cron?* Both scans
  iterate the same active-user set, are idempotent, and have their
  own Redis cooldowns. A second cron would duplicate the user fan-out.
- *Why both sticky-scans AND min-delta-bps?* The streak gate is the
  noise filter (winner must be stable across scans). The delta-bps
  gate is the per-user "is the move worth it" check at nudge time —
  the streak's APY is the winner's, not the user's current. Without
  delta-bps, a sticky winner with a tiny uplift would still nudge.
- *Why `kind: undefined` on rebalance sign requests?* The mini-app's
  deposit/withdraw confirm screens are kind-routed; reusing one would
  mislabel the other leg, and adding a new `yield_rebalance` kind
  requires a lockstep FE change that's out of scope for the BE plan.
  Default sign confirm is a clean fallback.

**Conventions introduced (recorded for future agents):**
- `TriggerSpec.callbackPrefix` may be `string | string[]`. Registry
  expands arrays. One capability can own multiple prefix families
  when they share signing infra.
- Auto-rebalance Redis keys live under the `yield:` namespace — see
  STATUS.md.

## Yield bug-fix batch — 2026-05-04

Implemented Part A of `be/constructions/2026-05-04-yield-fixes-and-auto-rebalance.md` (audit fixes; no surface change).

**What was done:**
- A1: `SubgraphPrincipalProvider` boot-warns when `THEGRAPH_API_KEY`
  is unset (was silently returning null and zero-ing lifetime PnL).
  Exposes `status()` via `/health.services.subgraph` with values
  `ok | degraded | disabled`. Auth-shaped failures (`401/403`) log
  `warn` once-per-process; subsequent failures log `debug`.
- A2: `yieldPoolRanker.computeScore` now uses a true EMA
  (`α = 2/(N+1)`) on the newest-first history. Previous arithmetic
  mean was harmless with one adapter but would diverge from the
  documented formula the moment a second adapter ships. Exported
  `computeEma` for unit testing.
- A3: `scripts/verify-aave-apy.ts` reads raw `liquidityRate` via
  `getReserveData` and prints both `rate/1e27` (no-compound APR)
  and `(1 + APR/n)^n - 1` (production APY). Verified 2026-05-04 on
  Avalanche USDC: rate = 5.7522% APR → 5.9208% APY. Cross-checked
  against Aave's own formatter (`aave-utilities` →
  `calculateCompoundedInterest` → `binomialApproximatedRayPow`,
  exactly what `app.aave.com` uses). Formula confirmed, kept;
  confirming comment added in `aaveV3Adapter.ts`. Companion
  `scripts/flush-yield-apy-history.ts` staged but not run (formula
  unchanged → ray-EMA history is still valid).
- A4: `yieldReportJob` user enumeration now unions
  `yieldRepo.listUsersWithRecentSnapshots` with
  `telegramSessions.listActiveUserIds` so users who deposited before
  the snapshot path was wired (or whose `finalizeDeposit` failed)
  appear in the daily run. Per-user work runs under `pLimit(5)`.
- A5: New `IYieldRepository.listSnapshotsBetween(userId, fromIncl,
  toExcl)`. `yieldOptimizerUseCase.{getPositions,buildDailyReport}`
  now query `[startOfYesterdayUtc, startOfTodayUtc)` instead of the
  off-by-one `listSnapshots(_, yesterdayEpoch - 1)` (which leaked
  today's snapshot into the yesterday delta calc).
- A6: `finalizeWithdrawal` symmetric with `finalizeDeposit` —
  re-discovers positions per chain and upserts a fresh snapshot
  (typically `balanceRaw=0`) so the daily report reflects the
  withdraw immediately. Wraps in try/catch — never rethrows since
  the on-chain withdraw already succeeded.
- A7: Yield-job DI getters in `assistant.di.ts` emit a one-shot
  `feature:yield, reason:redis-missing` warn when they return
  `undefined`. `workerCli.ts` logs a `jobs:{poolScan,idleScan,report}`
  status line at boot, mirroring stock soft-fail.

**Why this approach:**
- Verify-first on A3 is non-negotiable — silently changing APY math
  could inflate or deflate every prior daily report. The flush
  script is staged (not run yet) for the same reason.
- The bootstrap fix in A4 piggybacks on existing `buildDailyReport`:
  it already writes today's snapshot per discovered position and
  falls back to `prevBalance = currentBalance` when no yesterday
  snapshot exists → delta=0 on bootstrap day. The only real gap was
  user enumeration; the union closes it.
- A5 uses an explicit window `[from, to)` rather than patching the
  off-by-one, so the boundary is greppable in reviews.
- A6 groups by `chainId` to amortise discovery RPC across positions.

**New conventions to preserve:**
- Subgraph health surfaces in `/health.services.subgraph` —
  deployment dashboards may scrape it.
- `IYieldRepository.listSnapshotsBetween(from, to)` is the canonical
  way to ask for a UTC-day window. Do **not** add a second variant
  on top of `listSnapshots(_, sinceEpoch)` for the same purpose.
- Job-not-started warnings are gated by per-process booleans on the
  DI instance — every other DI getter that returns `undefined`
  should follow the same warn-once pattern.

## Stock close / SL-TP / `/positions` — 2026-05-04 (Phase 3)

**What was done:**
- `/stock close <SYM>` resolves the user's open Aster position via
  `IStockUseCase.resolvePositionForSymbol`. `kind === "none"` returns a
  plain message; `kind === "many"` renders an inline keyboard
  (`stock:close-pick:<tradeHashShort>` — first 12 chars after `0x`) that
  re-enters `runClose` with a concrete `tradeHash`. Loyalty awards
  `stock_close` on success.
- `/stock sl <SYM> <PRICE>` and `/stock tp <SYM> <PRICE>` reuse the same
  resolver (multi-position case rejects with a hint to close one first).
  `buildSetExitsPlan` reads the existing SL/TP off the matched position
  and only overrides the side the user is editing — preserving the other
  to avoid clobbering. No loyalty award.
- `/positions` is a thin `PositionsCapability` that delegates to
  `assistantUseCase.chat()` with a fixed seed prompt nudging the LLM
  toward the `get_stock_positions` system tool. Excluded from the
  `SendCapability` loop in `assistant.di.ts`.

**Why this approach:**
- Disambiguation in the capability (not the use-case) keeps the use-case
  pure: callers always invoke it with a concrete `tradeHash`. The inline
  keyboard mirrors the swap/yield disambiguation pattern.
- Reading current SL/TP from the cached position (rather than asking the
  user to re-enter both) matches the construction's "don't clobber" rule
  and avoids a second round-trip.
- For `/positions`, the dedicated thin capability is the construction's
  alternative to a command-mapping seed (both ~30 LOC). It avoids
  touching `AssistantChatCapability` triggers and reuses the existing
  tool registry — the LLM already has access to `get_stock_positions`
  through the per-user registry factory.

**New conventions:**
- Capabilities that return cached domain state should use the existing
  `resolvePositionForSymbol` shape (`{ kind: "none" | "one" | "many" }`)
  rather than throw on ambiguity. Disambiguation belongs at the
  capability layer.
- Callback prefix `stock:close-pick:<tradeHashShort>` — 12-char truncation
  of `tradeHash` (post-`0x`). Telegram payload limit forced the truncation.

## Ankr-backed transfer history — 2026-05-04

**What was done:**
- New port `ITransferHistoryProvider` (`use-cases/interface/output/blockchain/transferHistoryProvider.interface.ts`) — single contract for "list of past on-chain movements" queries. Implementations: `AnkrTransferHistoryProvider` (merges `ankr_getTransactionsByAddress` + `ankr_getTokenTransfers` on `(txHash, logIndex)`, native + ERC-20 in one page), wrapped by `CachedTransferHistoryProvider` (Redis cache + per-user/global rate guards).
- New cache port `ITransferHistoryCache` + `RedisTransferHistoryCache` (`adapters/.../cache/redis.transferHistory.ts`). Three Redis-backed mechanisms: fresh page TTL, stale companion (served on global-gate refusal), per-user sliding-window counter, global per-second token bucket.
- New use case `TransferHistoryUseCaseImpl` resolves SCA from `userProfileDB`, clamps `limit` to `[1, 100]`, calls a per-userId-bound provider via factory.
- New HTTP route `GET /transfers` (Bearer-Privy auth) — query params `fromEpoch`, `toEpoch`, `direction`, `limit`, `cursor`. Maps `RateLimitedError` → 429 (with `Retry-After`), `UnsupportedChainError` → 400. Sets `Cache-Control: private, max-age=30`.
- New agent tool `get_transfer_history` (registered in `SystemToolProviderConcrete`) — Markdown table output, tx hashes link to the chain explorer via `getExplorerTxUrl`. Time bounds via `fromEpoch`/`toEpoch` (unix seconds).
- New env knobs in `helpers/env/transferHistoryEnv.ts` (`TRANSFER_HISTORY_RPM_USER`, `TRANSFER_HISTORY_RPS_GLOBAL`, `TRANSFER_HISTORY_PAGE_TTL_SEC`, `TRANSFER_HISTORY_PAGE_OLDER_TTL_SEC`, `TRANSFER_HISTORY_STALE_TTL_SEC`). Reuses existing `ANKR_API_KEY`. No DB migration.
- New shared error types: `RateLimitedError` and `UnsupportedChainError` in `helpers/errors/`.

**Why:**
- Free-tier Ankr quota would be trivially exhausted by an open Activity tab + an over-eager agent loop without a shared cache layer. Day-bucketed cache keys mean the LLM's varying epochs for "last week" across turns hash to one slot. Per-user gate stops a runaway loop; global gate protects the shared key when traffic spikes; stale serve degrades gracefully instead of erroring under gate pressure.
- Splitting "fetch" (adapter) from "rate guard + cache" (decorator) lets us swap to a future RPC ingester without touching the use case, HTTP route, or tool.

**New conventions (do not break):**
- `ITransferHistoryProvider` is the **single port** for any "list of past on-chain movements" query. Future RPC ingester or alt-vendor adapter must implement this interface — do not add a parallel port.
- The `CachedXxxProvider(inner, cache, userId, cfg)` shape is the **template for per-user rate guards on free-tier external providers**. Reuse `acquireUserSlot(userId, rpm)` + `acquireGlobalSlot(rps)` semantics on any future free-tier integration; never inline rate-limit logic into adapters.
- `RateLimitedError` is **generic**, not Ankr-specific. Use it for any provider-side rate-limit signal. HTTP layer maps it to 429 with `Retry-After`; agent tools map it to a graceful "try again" message via `error: "history-rate-limited"` (or equivalent).
- `UnsupportedChainError` carries `chainId`. HTTP layer maps to 400; agent tools surface chain-not-supported rather than retrying.
- Cursor is **opaque**; the Ankr adapter encodes a `{tx, token}` pair as JSON. Callers must pass it back unmodified.
- New log scopes: `AnkrTransferHistoryProvider`, `CachedTransferHistoryProvider`, `redisTransferHistoryCache`, `transferHistoryUseCase`, `getTransferHistoryTool`. New metadata fields: `count` (page size), `choice: "hit"|"miss"` on cache lookups (already standard), `stale: boolean` on global-gate fallback events.

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

---

## 2026-05-05 — `/delegation/approval-params` cross-chain override fix

**What changed:** `httpServer.ts:handleGetDelegationApprovalParams` no longer **synthesises** a row when the `?tokenAddress=…&amountRaw=…` override doesn't match any token resolved on the target `chainId`. It now silently skips with a debug log (`choice: 'skipped-not-on-chain'`).

**Why:** Multi-chain onboarding (`ApprovalOnboarding` in FE) calls `/delegation/approval-params` once per onboarding chain, forwarding the same `(tokenAddress, amountRaw)` pair from the request. The address only exists on the source chain, so on every other chain the override fell through to the `else { resolved.push(...) }` branch and pushed `{ tokenSymbol: "", tokenDecimals: 18, ... }`. That broke setup two ways: (1) blank token chip with a microscopic raw-at-18-decimals amount in the UI, (2) the FE then POSTed that empty-symbol row to `/delegation/grant`, which 400s on `tokenSymbol.min(1)` zod validation, surfacing as `grant-post-failed`.

**Convention:** `?tokenAddress`/`?amountRaw` are an **override on existing rows**, not an injector. They never add new tokens to a chain's resolved set. If the override address isn't in the chain's registry, the request is treated as if the override weren't passed. The FE is also defensive — it filters out any blank-symbol/empty-address rows before display and before POST `/delegation/grant`.

---

## 2026-05-05 — Cancel in-flight `waitFor` on new user command

**What changed:** `SigningRequestUseCaseImpl` now tracks every active `waitFor` by `requestId` and indexes them by `userId`. The new `cancelActiveForUser(userId)` method (added to `ISigningRequestUseCase`) fires every active waiter for that user, which races a cancel-promise inside the poll loop and returns `{ status: "expired" }` immediately. The Telegram input adapter (`telegram/handler.ts`) calls it at the top of every text-message and callback-query branch, *before* dispatching to the capability layer.

**Why:** Capabilities like swap/stock/yield call `await signingRequestUseCase.waitFor(requestId, 10 * 60 * 1000)` to chain multi-step signing flows. grammy serialises updates per chat by default, so if a user fired off an intent and then sent a new command without opening the mini-app, the new command was queued behind the prior 10-minute waiter — observed in logs as a long stream of `signingRequestCache:hit` lookups for one stale `id`, with no progress. Pre-empting the waiter unblocks grammy's queue immediately. The previously-running capability still gets a clean return (`status: "expired"`) and emits its mid-flow timeout artifact, which is the right UX: the user sees that the abandoned flow was discarded and then the response to their new command.

**Conventions introduced:**
- `cancelActiveForUser` is the canonical pre-emption hook. Any future input adapter that processes user commands must call it before dispatch (or accept that fresh commands may queue behind prior waiters).
- Cancellation surfaces as `step: "waitFor-cancelled"` (info) on the `signingRequest` logger and `pre-empted in-flight signing waits` on `telegramHandler`. Metadata: `userId`, `cancelled` (count), `source: 'text' | 'callback'`.
- `waitFor` is the only place that mutates `cancelByRequestId` / `requestsByUserId`. Any future code path that adds a different blocking wait must register/deregister with the same maps or expose its own cancel hook.

---

## Fallback chat scope restriction

**What:** Tightened `DEFAULT_SYSTEM_PROMPT` in `be/src/use-cases/implementations/assistant.usecase.ts` (the prompt used by `AssistantChatCapability` — the dispatcher's default fallback) with an explicit `SCOPE — STRICT` section. The LLM is now instructed to refuse anything not related to crypto / DeFi / blockchain / on-chain actions / tokens / trading / tokenized stocks / wallets / portfolios with a short polite line ("Sorry, I can only help with crypto and on-chain questions."), and to treat prompt-injection / jailbreak / "ignore previous instructions" attempts the same way.

**Why:** The fallback path forwards arbitrary free text to the LLM. Without a scope rule the assistant would happily answer general-knowledge, coding, translation, role-play, etc. — wasted tokens and an exploitation surface. System-prompt hardening was chosen over a pre-flight classifier (option B) because the tool registry is already crypto-only, so the marginal value of a second LLM call did not justify the added latency/cost. If exploit traffic appears, layer in a classifier ahead of the chat loop.

**Convention introduced:**
- The fallback chat capability is **scope-locked to crypto/on-chain topics**. Any future change to `DEFAULT_SYSTEM_PROMPT` must preserve the `SCOPE — STRICT` paragraph (or replace it with an equivalent guard). Do not loosen it without an explicit product decision recorded here.
- Refusal phrasing is intentionally short and tool-free — the LLM must not call `route_intent` or any read tool when refusing.

---

## 2026-05-05 — `/stock buy` flow patches (P0/P1 from `2026-05-05-buy-stock-flow-fixes.md`)

**What changed:**
- **Aegis-Guard pre-flight on `runOpen`** (§P0.1). `StockCapability.runOpen` now runs `checkTokenDelegation` against home-chain USDC at the top of the flow, mirroring `swapCapability`. On insufficient delegation it persists a `PendingIntent` keyed on the reapproval `requestId` and returns the reapproval mini-app artifact directly; `signingRequest.usecase.resumePendingIntent` re-enters `run()` with the same params after the user approves. New deps on `StockCapabilityDeps`: `tokenDelegationDB`, `pendingIntentStore`, `tokenRegistry`.
- **`/buy <stock>` reroute** (§P0.3). `BuyCapability` now takes an optional `IStockPairRegistry`. When the user types `/buy AAPL` (or any free-text containing a stock symbol that resolves through `resolveByQuery`), it returns a chat artifact pointing the user at `/stock buy …` with an inline-keyboard button → `stock:reroute:<SYMBOL>` callback. The callback re-prompts for an amount (no default) and resumes via the new `awaiting_amount` state in `StockCapability.collect`.
- **Recovery success/failure copy** (§P0.4). `notifyResolved` now branches on `planKind === "recovery"` BEFORE the generic error/rejection branches: success says "Funds returned — your USDC is back on $homeChain"; rejection says "Recovery failed — contact support with this request id". `SigningResolutionEvent.requestId` is a new field threaded from `signingRequest.usecase`.
- **Synthetic-perp wording in preview** (§P0.5). The first preview field on `runOpen` is now an explicit `"What this is"` line clarifying the position is a synthetic perp tracking the symbol's price, not company shares. Plus updated `/stock` usage hint copy.
- **Close → return-swap chaining race fix** (§P1.1). `executeSignSteps` gained an opt-in `onStepResolved` hook fired AFTER each successful resolution (`resolution.txHash` known) but BEFORE the loop advances. `runClose` uses it on the last close step to call `buildReturnSwapPlan` and pre-queue the first return-swap step into the mini-app cache, then passes that requestId to the chained `executeSignSteps` call via `firstStepRequestId` so step 0 reuses the pre-queued record instead of double-writing.
- **Open-leg slippage haircut** (§P1.2). `stock.usecase.buildOpenPlan` haircuts `swap.expectedOutRaw` by `ASTER_ENV.openSlippageBps` (default 100 = 1%) before computing `qty1e10` AND before passing to `buildOpenPositionTxs`, so realistic Relay slippage doesn't revert the venue `transferFrom(amountIn)`. New env: `ASTER_OPEN_SLIPPAGE_BPS`.

**Why this approach:**
- The guard pre-flight is identical in spirit to `swapCapability` — copy/paste keeps the resume contract uniform across capabilities and avoids divergent reapproval UX.
- The `/buy <stock>` reroute is deterministic (regex + registry lookup), no LLM round-trip; gives the user a clear path even when they typed the wrong slash command.
- Pre-queuing the next request inside the resolution callback (instead of after `executeSignSteps` returns) closes a real race where the FE's `fetchNextRequest` fires immediately after `reportTxHash` resolves and finds nothing queued yet.

**New conventions:**
- New `StockCapabilityDeps` fields are all optional (`tokenDelegationDB`, `pendingIntentStore`, `tokenRegistry`); the capability silently skips the guard pre-flight if any are missing — Redis-less boot still works.
- `executeSignSteps` accepts `onStepResolved(i, txHash)` — fired after each successful step, errors are logged but never abort the loop. Use this for any future "queue follow-up before advancing" pattern.
- `executeSignSteps` accepts `firstStepRequestId` — when set with `continueSession: true`, step 0 skips create+store and reuses the pre-queued requestId. Pair with `queueFirstStepIntoCache`.
- `SigningResolutionEvent.requestId` is now mandatory. Any new resolution-event consumer can rely on it for support copy / correlation.
- Recovery-flow signing records take precedence in `notifyResolved` over generic error / rejection branches. Don't shadow the recovery branch with new generic handlers.
- Preview field copy convention: open previews lead with a `"What this is"` muted-line description before mechanical fields (Symbol, Notional, Mark, Leverage). Mirror this on any future synthetic-asset preview.
- Slippage haircut is applied in the use-case (`stock.usecase`) before sizing — never in the capability or broker. The user-facing notional is still the input value (no double-display).

**Files touched:** `stockCapability.ts`, `buyCapability.ts`, `notifyResolved.ts`, `stock.usecase.ts`, `asterEnv.ts`, `routeIntent.tool.ts`, `stockOpen.tool.ts`, `signingRequest.{interface,usecase}.ts`, `aster/status.md`, `assistant.di.ts`.

---

## 2026-05-06 — `/stock buy` slot-fill for missing amount

**What changed:**
- `StockCapability.collect` no longer rejects symbol-only invocations (e.g. natural-language "buy apple stock" or `/stock buy AAPL` with no amount). When `parseAmountSymbol` resolves a symbol but no amount, it now returns `kind: "ask"` with `state: { stage: "awaiting_amount", symbol, verb }`, reusing the existing `awaiting_amount` resume handler that previously only served the `/buy <stock>` reroute path.
- `parseAmountSymbol` return type changed from `{ amountUsd, symbol } | null` to `{ amountUsd?, symbol? }` — partial results are now first-class so the caller can distinguish "no symbol recognized" (→ `usageHint`) from "symbol-only" (→ ask).
- The `awaiting_amount` resume branch now reads `verb` from state instead of hard-coding `"buy"`, so a user who said "short apple" and is then asked for an amount resumes as a short.
- `stock_open` LLM tool: `amountUsd` is now `optional` in the input schema, with the description telling the model to OMIT the field (not invent a default) when the user didn't specify one. When omitted, the dispatched command is `/stock <side> <SYMBOL>` (no `$<amount>`), and the tool result tells the model the user has been asked for the amount and to wait for their reply.

**Why this approach:**
- Reusing the already-shipped `awaiting_amount` slot-fill avoided introducing the manifest-driven `getMissingRequiredFields` / `generateMissingParamQuestion` pipeline that `sendCapability` and `swapCapability` use — that pipeline requires a `CapabilityManifest`, which `stockCapability` doesn't have. Both entry points (LLM tool, direct slash command) now share a single ask path.
- Making `amountUsd` optional at the tool layer is the upstream fix: previously the model would hallucinate an amount to satisfy the required-string schema, which is how "buy apple stock" was reaching the mini-app's confirm button without ever asking the user.

**New conventions:**
- When a regex/parser-driven capability has required slots, the parser should return *partial* matches rather than null-on-missing, and the `collect` caller decides whether to ask or hint. Don't conflate "input was unparseable" with "input parsed but a slot is missing."
- LLM tool schemas for capabilities that have a slot-fill path SHOULD mark the slot-fillable fields `optional` in zod and explicitly tell the model to omit (not default) — otherwise the model invents values.

**Files touched:** `stockCapability.ts`, `stockOpen.tool.ts`, `assistant.usecase.ts`, `stock.usecase.ts`.

**Follow-up #3 (same day):** "buy tesla stock" → "5" → cryptic "Something went wrong" with code. Root cause: `stock.usecase.buildOpenPlan` called `divFixed(collateralUsd, mark.priceUsd, 10)` with `mark.priceUsd === "0"` because Aster's oracle returns 0 for US tickers outside market hours (this was the long-standing §P2.1 TODO). The "divFixed: division by zero" throw didn't match any errorCatalog pattern, so it fell through to `code: "internal"` and the generic message. Fix: validate `mark.priceUsd` immediately after `oracle.markPrice` and throw `MARKET_CLOSED — oracle returned no mark price for <SYMBOL>`, which the catalog maps to the friendly "US markets are closed right now. Try again when they reopen." Convention: any sizing math that consumes oracle prices MUST validate the price is positive before passing it to `divFixed`/`toRaw`/etc., and surface a catalog-recognised error so the user gets a meaningful message instead of an opaque request id. Freshness/staleness (non-zero but old quotes) remains unhandled — still part of §P2.1.

**Follow-up #2 (same day):** the `awaiting_amount` resume handler was eating fresh stock commands ("buy tesla stock" while a previous "buy apple stock" left the user in `awaiting_amount`) as malformed amount replies, and re-asking with a contextless "Please reply with a number, e.g. 50." Two fixes: (a) when the resume input is non-numeric, sniff for a fresh-command shape (`/`-prefix, or starts with `buy|short|sell|close|sl|tp|long|stock`) and fall through to the normal parse path so the new command takes over; (b) the re-ask question is now self-contained — "I didn't catch a number. How much USD would you like to buy of AAPL? Reply with just a number, e.g. 50." Convention: any slot-fill resume handler that reads free text MUST detect fresh-command inputs and drop pending state rather than trapping the user in the slot.

**Follow-up (same day):** the model paraphrased the capability's "How much USD…" prompt back to the user, producing a duplicated question. Fixed by (a) extending the assistant system prompt's "reply with an empty string" rule from `route_intent` to also cover `stock_open`, and (b) tightening the tool's `data` string to explicitly tell the model not to ask, rephrase, or acknowledge — the capability has already shown the prompt. Convention: any tool whose dispatch results in a user-visible chat message (mini-app, ask, result card) MUST end its `data` string with "Reply with an empty string; do NOT acknowledge or rephrase," and the system prompt's empty-reply rule must list the tool name explicitly.
