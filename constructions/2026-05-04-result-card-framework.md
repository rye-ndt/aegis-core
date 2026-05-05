# Result Card Framework — BE Plan

**Goal:** every user-facing capability outcome (success, failure, confirmation) is rendered through one structured pipeline producing a consistent, plain-English receipt. Kill ad-hoc `text:` strings, kill markdown tables, kill raw error leakage.

**Strict non-goal — NO behavior or procedure change.** This is a presentation-layer revamp only. Specifically:

- No new taps, buttons, prompts, or flows are introduced anywhere a user touches.
- Every existing message a user sees today continues to exist; we are only changing *how it looks* and *what words it uses*.
- Every existing button (mini-app open button, "View on explorer" link, yield rebalance Yes/Skip nudge, mini-app Approve/Reject) stays exactly as it is.
- The mini-app modal's body changes from raw `to`/`value`/`calldata` to a structured human-readable summary, but the Approve/Reject footer and the single-tap-to-confirm behavior are untouched.
- Nothing is removed from a user's view (e.g. the existing pre-sign quote summary in Telegram is preserved, just reformatted).

If a section of this plan implies any behavior change, treat it as a bug in the plan and flag before implementing.

**Benchmark:** a teenager with one week of crypto experience must understand every sentence the bot sends. If they can't, the renderer failed.

---

## 0. Locked assumptions (confirmed by user)

1. **LLM interpretation:** ON only for *complex* outcomes — yield rebalance, swap (multi-hop / cross-chain), daily yield report, transfer history summary, portfolio summary. **OFF** for simple sends, single-hop same-chain swaps, balance lookups, single-position queries. Determined per-capability via a `complexity` flag on `IntentResult`.
2. **Confirmation:** NO new Telegram-side Yes/No gate is added. The mini-app's existing approve screen IS the confirmation step. Today it shows raw `to`/`value`/`calldata`; this plan makes it show a clean, human-readable summary instead. The auto-sign vs manual-sign decision tree (and the user's single tap to approve inside the mini-app) is unchanged. The yield-rebalance nudge already has its own Yes/Skip flow in Telegram and stays as-is — that's a *suggestion* prompt ("we noticed a better pool, want to move?"), not a tx-confirmation gate.
3. **Localization:** English only. Templates use string keys but no i18n dispatcher yet — leave a `// TODO(i18n)` next to every literal.
4. **Assistant tool-call results in scope:** `get_transfer_history`, `get_balance`, `get_stock_positions`, `get_portfolio_summary` (and any other read-only system tool that currently emits markdown tables) must route through the same renderer.

---

## 1. Domain model

### 1.1 New file: `be/src/use-cases/interface/input/resultCard.types.ts`

The neutral, capability-agnostic shape every capability returns at the end of a flow. The renderer is the only place that knows about Telegram MarkdownV2.

```ts
export type ResultStatus = "success" | "pending" | "failed" | "preview";
// `preview` is rendered ONLY inside the mini-app's existing approve modal —
// it never produces a Telegram message. There is no `confirm` status because
// there is no Telegram-side Yes/No gate.

/** One canonical verb per intent. Drives headline phrasing. */
export type IntentVerb =
  | "send"
  | "swap"
  | "yield_deposit"
  | "yield_withdraw"
  | "yield_rebalance"
  | "stock_buy"
  | "stock_close"
  | "stock_set_exits"
  | "buy_onramp"
  | "history_query"
  | "balance_query"
  | "positions_query"
  | "portfolio_summary"
  | "loyalty_query";

export interface ResultField {
  /** Human-friendly label, e.g. "Rate", "Fee", "You sent". */
  label: string;
  /** Pre-formatted value string. Renderer never re-formats. */
  value: string;
  /** Render hint: "primary" lines bold; "muted" lines dim/grey-equivalent. */
  emphasis?: "primary" | "normal" | "muted";
}

export interface ResultAction {
  /** Tappable next-step suggestion. */
  label: string;
  /** Either a slash command ("/yield"), or a callback string ("rebalance:y:..."). */
  kind: "command" | "callback" | "url";
  payload: string;
}

export interface IntentResult {
  status: ResultStatus;
  verb: IntentVerb;
  /**
   * Past tense for success/failed (Telegram receipt). Imperative/present for preview (mini-app body, e.g. "Swap 5 USDC for AVAX").
   * The renderer prepends the status-emoji anchor.
   */
  headline: string;
  /** Short body fields, vertically stacked. Renderer enforces max ~5. */
  fields: ResultField[];
  /** Tx hashes for the explorer link (final/settlement tx is .at(-1)). */
  txHashes?: { hash: string; chainId: number }[];
  /**
   * Suggestions for "what's next". MANDATORY on success/failed; optional on
   * preview (mini-app modal — Approve/Reject footer is owned by the modal, not the card).
   */
  nextActions?: ResultAction[];
  /** True ⇒ run LLM interpreter post-hoc and append a 1-sentence note. */
  complexity?: "simple" | "complex";
  /**
   * For `complex` results: typed payload the interpreter consumes. The
   * interpreter signature is per-verb so we don't ship arbitrary JSON to the
   * LLM. Keep this minimal.
   */
  interpreterContext?: Record<string, unknown>;
  /**
   * Truncate the final message and put noisy detail (tx hashes, gas, slippage,
   * route) under "Show details ▾". Renderer puts these in a Telegram spoiler
   * block (`||...||`) so they're collapsed by default.
   */
  details?: ResultField[];
  /** Correlation id for support. Always include on `failed`. */
  requestId?: string;
}
```

### 1.2 New artifact kind: `result_card`

In `be/src/use-cases/interface/input/capability.interface.ts`, extend `Artifact`:

```ts
| { kind: "result_card"; result: IntentResult; keyboard?: InlineKeyboard }
```

We keep `kind: "chat"` for legacy/free-form replies (e.g. ask-disambiguation prompts), but **all terminal outcomes from a capability must be `result_card`**.

`keyboard` is optional and lets a capability override/augment what the framework derives from `nextActions`. If unset, the renderer builds the keyboard from `nextActions` and `txHashes` (explorer button).

---

## 2. Error catalog

### 2.1 New file: `be/src/helpers/errors/errorCatalog.ts`

Mirror the FE's `interpretSignError.ts` on the BE for **server-side** errors (Relay HTTP, Aave revert, Aster API, Ankr, internal). Distinct from `interpretSignError` — different sources.

```ts
export type ErrorCode =
  | "amount_too_low"
  | "amount_too_high"
  | "no_route"
  | "no_liquidity"
  | "insufficient_balance"
  | "insufficient_gas"
  | "insufficient_allowance"
  | "rate_limited"
  | "service_unavailable"
  | "unsupported_chain"
  | "unsupported_token"
  | "recipient_unresolved"
  | "delegation_required"
  | "delegation_exceeded"
  | "stock_market_closed"
  | "stock_oracle_stale"
  | "stock_min_size"
  | "stock_pair_inactive"
  | "yield_winner_changed"
  | "yield_position_vanished"
  | "transfer_history_unavailable"
  | "internal";

export interface InterpretedError {
  code: ErrorCode;
  /** Plain-English, teenager-readable. No jargon, no codes, no hex. */
  friendly: string;
  /** Optional one-tap recovery action surfaced as nextActions[0]. */
  recovery?: {
    label: string;
    kind: "command" | "callback";
    payload: string;
  };
  /** Original error string, kept server-side; never returned to user. */
  raw: string;
  /** Correlation id for support. */
  requestId: string;
}

export function interpretError(err: unknown, ctx: {
  verb: IntentVerb;
  requestId: string;
}): InterpretedError;
```

Pattern table is the same shape as `interpretSignError.ts` (regex → code → friendly). Initial entries (cover the top errors actually observed in logs):

| Pattern (regex, case-insensitive) | code | friendly | recovery |
|---|---|---|---|
| `AMOUNT_TOO_LOW`, `Amount is too small` | `amount_too_low` | "That amount is too small for this route. Try at least $1." | `{label:"Try $1", kind:"command", payload:"/swap $1 to <to>"}` (verb-aware) |
| `AMOUNT_TOO_HIGH`, `exceeds.*max` | `amount_too_high` | "That amount is too large for this route. Try a smaller amount." | none |
| `NO_ROUTE`, `route not found`, `RELAY_QUOTE_FAILED` (generic, no sub-code match) | `no_route` | "Couldn't find a route right now. Please try again in a moment." | `{label:"Retry", kind:"callback", payload:"retry:<verb>"}` |
| `NO_LIQUIDITY` | `no_liquidity` | "There isn't enough liquidity for this swap right now. Try a smaller amount or a different token." | none |
| `insufficient.*balance`, `transfer amount exceeds balance` | `insufficient_balance` | "You don't have enough <symbol> to do that. Tap below to top up." | `{label:"Top up", kind:"command", payload:"/buy"}` |
| `AA21`, `prefund` | `insufficient_gas` | "Your account is low on gas. Top up to continue." | `{label:"Top up", kind:"command", payload:"/buy"}` |
| `delegation.*required`, `no token delegation` | `delegation_required` | "You need to grant Aegis permission to spend this token first." | `{label:"Grant permission", kind:"callback", payload:"delegation:grant:<token>"}` |
| `delegation.*exceeded`, `spend.*limit` | `delegation_exceeded` | "You've reached your spending limit for this token. Raise it to continue." | `{label:"Raise limit", kind:"command", payload:"/permissions"}` |
| `429`, `rate.?limit` | `rate_limited` | "Things are busy right now. Please try again in a moment." | none |
| `503`, `service unavailable`, `ECONNREFUSED` | `service_unavailable` | "The service is briefly unavailable. Please try again in a moment." | none |
| `UnsupportedChainError` (instance check) | `unsupported_chain` | "That chain isn't supported yet." | none |
| `recipient.*not.*resolved`, `unknown.*handle` | `recipient_unresolved` | "Couldn't find that recipient. Double-check the @handle or wallet address." | none |
| `MARKET_CLOSED`, `outside.*trading hours` | `stock_market_closed` | "US markets are closed right now. Try again when they reopen." | none |
| `STALE_PRICE`, `oracle.*stale` | `stock_oracle_stale` | "The stock price feed is briefly stale. Try again in a moment." | none |
| `MIN_TRADE_SIZE`, `below.*minimum` | `stock_min_size` | "That trade is below the minimum size. Try a larger amount." | none |
| `PAIR_INACTIVE` | `stock_pair_inactive` | "That stock isn't tradable right now." | none |
| `winner.*changed` (yield) | `yield_winner_changed` | "The best pool changed before we could rebalance — no action taken." | none |
| `position.*not.*found` (yield rebalance) | `yield_position_vanished` | "Looks like you already withdrew — nothing to rebalance." | none |
| (default) | `internal` | "Something went wrong on our side. Please try again." | none |

The catalog is **the only** place that turns errors into user-visible strings. Capabilities never inline `friendly:` text from caught errors. They call `interpretError(err, { verb, requestId })` and put the result into `IntentResult.fields` + `nextActions`.

### 2.2 Logging contract

`interpretError` MUST log at `error` level with `{ err: raw, code, requestId, verb }` before returning. The friendly string never leaks `requestId`/`code` back to the user *except* on `code === "internal"`, where the renderer appends a "If this keeps happening, tell us with code `<requestId.slice(0,8)>`" line. This is the only place a request id appears in a user-facing message.

---

## 3. Renderer (Telegram side)

### 3.1 New file: `be/src/adapters/implementations/output/artifactRenderer/resultCard.render.ts`

Pure functions — no side effects. Takes `IntentResult` and returns `{ text: string; keyboard?: InlineKeyboard; parseMode: "MarkdownV2" }`.

**Layout grammar (locked):**

```
<emoji> *<headline>*

<field 1 label>: <value 1>
<field 2 label>: <value 2>
...

<optional LLM note italic>

What's next: <action 1> · <action 2>
||🔍 Details
<details fields>
🔗 <truncated tx hash> (Avalanche)||
```

- Status emoji map (Telegram surfaces only): `success → ✅`, `pending → ⏳`, `failed → ⚠️`. `preview` never reaches Telegram — it is consumed by the mini-app, not the renderer.
- All values are **already formatted** by the capability. The renderer never touches numbers.
- All Telegram MarkdownV2 escaping happens here, via a single `escapeMd(s)` helper. Capabilities NEVER write MarkdownV2 — they hand plain strings, the renderer escapes.
- "Show details" uses Telegram spoiler syntax (`||...||`) — content is auto-collapsed; tap to reveal.
- Tx hash truncation: `0xabcd…1234` (first 6 + last 4 of post-`0x`).
- Explorer link in the `details` block: `[0xabcd…1234](https://snowtrace.io/tx/0x...)`. Resolved via `getExplorerTxUrl(chainId, hash)`.
- Inline keyboard:
  - For `success`/`failed`: row 1 = up to 3 `nextActions` buttons; row 2 = "🔍 View on explorer" if `txHashes` present.
  - If the capability passed its own `keyboard`, it is appended **below** the auto-built rows (don't replace — augment).
  - `nextActions[].kind === "command"`: render as bot-command via Telegram's `switch_inline_query_current_chat` is wrong — use a clickable text instruction (Telegram doesn't support tapping to send a slash command from a button reliably). Fallback: render the command in the body as `→ /yield` styled text, AND add a button with `callback_data: "cmd:/yield"` that the dispatcher catches and re-enters as text input. (See §3.4.)
  - `kind === "callback"`: standard `callback_data`.
  - `kind === "url"`: `.url(label, payload)`.

### 3.2 LLM interpretation pass

When `result.complexity === "complex"`, the renderer (or rather a thin wrapper around it — see §3.3 placement) calls `IIntentInterpreter.interpret({ verb, status, fields, interpreterContext })` BEFORE rendering. The interpreter returns a single italic sentence (≤ 25 words) appended between the body and "What's next".

If the interpreter call fails or times out (>2s), render without the note. **Never block the receipt on the LLM call.** Log `warn` with `{ err, verb, requestId }`.

### 3.3 Wire into `TelegramArtifactRenderer`

Modify `be/src/adapters/implementations/output/artifactRenderer/telegram.ts`:

- Add `case "result_card":` to the `render()` switch.
- Inject `IIntentInterpreter` (optional — see §4) via constructor.
- Inside the case: optionally await interpreter, render via `resultCardRender.render`, then `sendChat(chatId, text, mergedKeyboard, "MarkdownV2")`.
- Keep `case "chat":` untouched — used by ask-prompts and other intermediate text.

### 3.4 Slash-command relay

A small change in `be/src/adapters/implementations/input/telegram/handler.ts`: when a callback query has `data` starting with `cmd:`, strip the prefix and re-dispatch as a text input (`{ kind: "text", text: data.slice(4) }`). This makes "What's next" command suggestions tappable.

---

## 4. LLM Interpreter

### 4.1 New port: `be/src/use-cases/interface/output/intentInterpreter.interface.ts`

```ts
export interface InterpreterInput {
  verb: IntentVerb;
  status: ResultStatus;
  fields: ResultField[];                     // already-formatted body
  interpreterContext?: Record<string, unknown>;
}
export interface IIntentInterpreter {
  interpret(input: InterpreterInput): Promise<string | null>;  // null on failure
}
```

### 4.2 Implementation: `be/src/adapters/implementations/output/intentInterpreter/openai.intentInterpreter.ts`

Single OpenAI call (model from existing config). System prompt template — locked, must be tested:

```
You are Aegis, a friendly crypto assistant for Southeast Asian retail users.
Given the result of a {verb} action, write ONE sentence explaining what just
happened in plain English a teenager would understand.

Rules:
- ≤ 25 words.
- No jargon: do not say "calldata", "slippage", "gas", "AMM", "approval", "rebalance".
- Never include numbers the user didn't already see in the fields.
- No emojis.
- Past tense for success/failed.

Status: {status}
Fields:
{fields formatted as "label: value" lines}
Extra context (JSON): {interpreterContext}
```

- Timeout: 2000 ms. Cache key = `sha256(verb|status|fields|context)` for 5 min via existing redis cache. Cache to keep the daily report and rebalance summaries cheap on repeat views.
- Logged as scope `intentInterpreter` with `{ verb, status, durationMs, choice }`.

### 4.3 Where the call happens

In the renderer (§3.3). Centralising it there means capabilities can't "forget" — they only set `complexity: "complex"` and the framework does the rest.

---

## 5. Per-capability migration

### 5.1 Common pattern

Every capability that today returns `{ kind: "chat", text: ... }` for a terminal outcome migrates to:

```ts
return {
  kind: "result_card",
  result: {
    status: "success", verb: "swap",
    headline: `You swapped ${params.amountHuman} ${fromSym} into ${out} ${toSym}`,
    fields: [
      { label: "Rate", value: `1 ${fromSym} ≈ ${rate} ${toSym}` },
      { label: "Network fee", value: feeFormatted, emphasis: "muted" },
      { label: "Took", value: `${seconds}s`, emphasis: "muted" },
    ],
    txHashes: [{ hash: finalHash, chainId: params.fromChainId }],
    nextActions: [
      { label: "Earn yield on this", kind: "command", payload: "/yield" },
      { label: "Swap again", kind: "command", payload: "/swap" },
    ],
    complexity: sameChain ? "simple" : "complex",
    interpreterContext: !sameChain ? { fromChain, toChain, hops } : undefined,
    details: [
      { label: "Route", value: routeName },
      { label: "Slippage", value: `${slippageBps} bps` },
    ],
  },
};
```

### 5.2 Capabilities to migrate (in order — see §7)

1. `swapCapability.ts`
   - Drop the BE-side `buildQuoteSummary` Telegram message. The pre-tx quote summary moves into the mini-app via `sign_calldata.preview` (built with `buildPreview`). Telegram's pre-sign message becomes a tiny "Tap to review and approve" prompt attached to the `mini_app` artifact — already standard.
   - Replace `buildCompletionMessage` → returns `IntentResult{status:"success"}` for the post-success Telegram receipt.
   - Error path at `swapCapability.ts:192` (`Swap failed: ${toolResult.error ?? ...}`): replace with `interpretError(toolResult.error, {verb:"swap", requestId})` → `IntentResult{status:"failed"}`.
   - `complexity: "complex"` when `params.fromChainId !== params.toChainId` OR `txs.length > 1`. Else `"simple"`.

2. `sendCapability.ts`
   - Auto-sign path: attach `preview` to the `sign_calldata` artifact (recipient handle, amount, network fee). No new Telegram-side gate.
   - Manual-sign path (where the BE emits a `mini_app` artifact instead): same — preview is stored on the pending sign request the mini-app fetches.
   - Success/failed Telegram messages migrate to `result_card`.
   - `verb: "send"`. `complexity: "simple"` (always).

3. `yieldCapability.ts`
   - Deposit/withdraw: attach `preview` to each `sign_calldata` step (e.g. "Depositing 100 USDC into Aave for ~5.9% APY"). The "single mini-app session" UX (status.md "Yield one-click parity") is preserved — preview is just metadata, doesn't add a step.
   - Deposit/withdraw success → `result_card` (`yield_deposit` / `yield_withdraw`).
   - `runRebalance`: keep the existing `rebalance:y/n` *nudge* prompt unchanged — that's a suggestion, not a tx gate. Once the user accepts, the resulting sign request gets the standard `preview` ("Moving your 100 USDC from Benqi to Aave for a ~0.4% APY bump"). Success → `result_card` with `complexity: "complex"`, `interpreterContext: { fromProtocol, toProtocol, oldApy, newApy, sizeUsd }`.
   - Daily report (`buildDailyReport`): migrate to `result_card` with `verb: "portfolio_summary"` (or new `verb: "yield_daily_report"` — add to union), `complexity: "complex"`. Fields: yesterday's earnings, total balance, top mover. Details block: per-position list (label/value), no markdown table.

4. `buyCapability.ts`, `stockCapability.ts`
   - Attach `preview` to every sign request (e.g. "Buying $200 of Tesla — ~$0.50 fee").
   - Success/failure Telegram replies → `result_card` (`stock_buy`, `stock_close`, `stock_set_exits`, `buy_onramp`).
   - Stock errors leverage the catalog's stock_* codes.
   - `complexity: "complex"` on stock buy so the interpreter can frame it ("you now own $200 of Tesla — about 0.6 shares at today's price").

5. `assistantChatCapability.ts` (the "free chat" fallback)
   - When the LLM tool-call returns markdown table content (history/balance/positions/portfolio): the *tool* itself returns structured data (already true for `get_transfer_history`, partly true for others). Stop letting the LLM render the table. Instead, the capability detects "this tool result is a list of items" and emits a `result_card` with `verb: history_query`/`balance_query`/`positions_query`/`portfolio_summary`.
   - For balance: fields = up to 5 rows ("AVAX: 1.2", "USDC: 50.00", …) with a "Show all" details block.
   - For history: max 5 most recent entries as fields; details block contains the rest. Each entry's `value` is e.g. "Sent 5 USDC to alice (2 days ago)" — the tool already has the data, the renderer just stacks it.
   - Concretely: add a thin `assistantResultRouter.ts` that inspects the structured tool output (the tools were updated in `2026-05-04-ankr-transfer-history.md` to return JSON, not just text — confirm and pivot off that). If the tool output matches a known shape, build a `result_card`; otherwise fall back to `kind: "chat"` with the LLM's prose.

### 5.3 Helpers to share

Create `be/src/helpers/format/humanFormat.ts` for value formatting:

```ts
export function formatTokenAmount(raw: string, decimals: number, symbol: string): string;
export function formatUsd(usd: number): string;            // "$5.20", "<$0.01"
export function formatRelativeTime(epochSec: number): string; // "2 hours ago"
export function formatDuration(ms: number): string;        // "3 sec", "2 min"
export function truncateHash(hash: string): string;        // "0xabcd…1234"
```

All capability code must use these. No more inline `.toFixed()` or hand-rolled padding.

---

## 6. Preview-card plumbing (lives inside mini-app, not Telegram)

There is no new Telegram-side Yes/No gate. The mini-app's existing approve screen is the confirmation. We just upgrade what it shows from raw `to/value/calldata` to a clean preview.

How the preview reaches the mini-app:

1. Each capability that emits a `sign_calldata` artifact also builds an `IntentResult` with `status: "preview"` describing the transaction in plain English.
2. The `Artifact.sign_calldata` shape is extended with an optional `preview?: IntentResult` field. Capabilities populate it; the Telegram artifact renderer passes it through into the `SigningRequestRecord` (`signingRequest.cache`) when it stores the pending sign request.
3. The mini-app reads `preview` off the sign request payload it pulls via `GET /request/:id` and renders it via the FE `ResultCard` component (FE plan §3.1). If `preview` is absent, mini-app falls back to today's raw view — backward compatible during rollout.
4. The "approve" / "reject" buttons on the mini-app modal are unchanged. The card replaces the modal **body** only.

A small BE helper `buildPreview.ts` standardises preview construction so each capability writes one call:

```ts
preview: buildPreview({
  verb: "swap",
  headline: `Swap ${amount} ${fromSym} → ~${out} ${toSym}`,
  fields: [
    { label: "Rate", value: `1 ${fromSym} ≈ ${rate} ${toSym}` },
    { label: "Network fee", value: feeFormatted, emphasis: "muted" },
  ],
  details: [{ label: "Route", value: routeName }],
})
```

Same shape as a success/failed `IntentResult`, just with `status: "preview"` and never any `txHashes`/`nextActions`.

**Yield rebalance nudge stays as-is.** That existing `rebalance:y/n` Yes/Skip flow is a *suggestion* ("we found a better pool — want to move?"), not a tx confirmation. It precedes the sign request and is unrelated to this framework. Keep it.

---

## 7. Implementation order

Treat each numbered phase as one PR. Each phase is fully shippable: the framework is opt-in until the last phase deletes the legacy paths.

**P1 — Foundations (no UX change):**
- Create `resultCard.types.ts`, `errorCatalog.ts`, `humanFormat.ts`.
- Add `result_card` to `Artifact` union.
- Implement `resultCardRender.ts` + wire into `TelegramArtifactRenderer`.
- Implement `IIntentInterpreter` + OpenAI impl (gated by env `RESULT_CARD_INTERPRETER_ENABLED`; default OFF for P1, ON in P5).
- Add unit tests for renderer (snapshot tests on each verb × status combination — 12 snapshots minimum).
- Add `cmd:` callback handler in telegram input handler.

**P2 — Migrate `swapCapability`:** sign-request `preview` + post-tx `result_card` + error path. This is the worst offender (the `RELAY_QUOTE_FAILED` example in the brief). Verify visually on staging with the four canonical cases: amount-too-low, no-route, success same-chain, success cross-chain.

**P3 — Migrate `sendCapability`:** sign-request `preview` + post-tx `result_card` + error path.

**P4 — Migrate `yieldCapability`:** deposit/withdraw `preview` + result, rebalance (existing nudge unchanged; the resulting sign request gains `preview`), daily report → `result_card`.

**P5 — Migrate `buyCapability` + `stockCapability`:** all stock verbs.

**P6 — Migrate `assistantChatCapability`** (the read-only tool router). Also turn on the LLM interpreter (`RESULT_CARD_INTERPRETER_ENABLED=true`).

**P7 — Cleanup:** delete `buildQuoteSummary`, `buildCompletionMessage`, ad-hoc `Swap failed:` strings, etc. Grep for `kind: "chat"` in `capabilities/` — every remaining one should be a multi-turn ask-prompt; if a terminal `chat` slipped through, convert.

Each phase ends with a `status.md` update (capabilities/status.md) and `errorCatalog.md` (new) listing every code added.

---

## 8. Files to create

```
be/src/use-cases/interface/input/resultCard.types.ts
be/src/use-cases/interface/output/intentInterpreter.interface.ts
be/src/adapters/implementations/output/intentInterpreter/openai.intentInterpreter.ts
be/src/adapters/implementations/output/artifactRenderer/resultCard.render.ts
be/src/adapters/implementations/output/artifactRenderer/resultCard.escape.ts   (MarkdownV2 escaping)
be/src/adapters/implementations/output/capabilities/buildPreview.ts            (shared helper for sign_calldata.preview)
be/src/helpers/errors/errorCatalog.ts
be/src/helpers/format/humanFormat.ts
be/tests/resultCardRender.spec.ts                                              (snapshots)
be/tests/errorCatalog.spec.ts                                                  (regex matches)
```

## 9. Files to modify

```
be/src/use-cases/interface/input/capability.interface.ts        (add Artifact variant)
be/src/adapters/implementations/output/artifactRenderer/telegram.ts (new switch case + interpreter inject)
be/src/adapters/implementations/input/telegram/handler.ts          (cmd:* callback relay)
be/src/adapters/inject/assistant.di.ts                             (wire IIntentInterpreter)
be/src/helpers/env/* (new RESULT_CARD_INTERPRETER_ENABLED env)

be/src/adapters/implementations/output/capabilities/swapCapability.ts
be/src/adapters/implementations/output/capabilities/sendCapability.ts
be/src/adapters/implementations/output/capabilities/yieldCapability.ts
be/src/adapters/implementations/output/capabilities/buyCapability.ts
be/src/adapters/implementations/output/capabilities/stockCapability.ts
be/src/adapters/implementations/output/capabilities/assistantChatCapability.ts
be/src/adapters/implementations/output/capabilities/positionsCapability.ts
be/src/adapters/implementations/output/capabilities/loyaltyCapability.ts

be/src/use-cases/interface/input/capability.interface.ts        (Artifact.sign_calldata gains optional preview?: IntentResult)
be/src/use-cases/interface/output/cache/signingRequest.cache.ts (SigningRequestRecord gains optional preview)
be/src/adapters/implementations/output/cache/redis.signingRequest.ts (serialize/deserialize preview)
```

## 10. Logging

Per CLAUDE.md mandatory logging convention:

- New scopes: `resultCardRender`, `errorCatalog`, `intentInterpreter`.
- Emit `step` lifecycle on the interpreter: `started → succeeded|failed`, with `durationMs`.
- `errorCatalog.interpretError`: `log.error({ err: raw, code, requestId, verb }, "interpret-error")`.
- Renderer: `log.debug({ verb, status, hasInterpreter: !!note }, "render-result-card")`.
- Preview attachment (debug, once per sign request): `log.debug({ verb, requestId }, "preview-attached")` in `buildPreview`.

## 11. status.md updates

After each phase, update `be/src/adapters/implementations/output/capabilities/status.md` with: what changed, why, and any new conventions (especially for new verbs added to the `IntentVerb` union or new error codes).

Add a NEW `be/src/helpers/errors/status.md` documenting the error catalog — new codes go there before being added.

## 12. Out-of-scope (intentional, for follow-up)

- i18n (English only this iteration).
- Voice / image responses.
- Push notification framing — the recipient notification path uses its own pre-formatted strings and is not touched.
- The mini-app's in-app sign confirm screen — that's the **FE** plan (`fe/privy-auth/constructions/2026-05-04-result-card-framework.md`). The two plans share vocabulary (verb, status emoji, error codes) but are otherwise independent.

## 13. Open questions to flag during implementation

- Telegram MarkdownV2 spoiler (`||...||`) renders inconsistently across older clients. If staging QA finds breakage on Telegram Desktop < v4, fall back to a plain `\n_— tap "Show details" below —_` line + an inline button that posts the details as a follow-up message.
- The interpreter is OpenAI-only initially. If latency on cross-chain swap success becomes user-visible (>1.5s typical end-to-end), move the interpreter call onto a fire-and-forget edit: send the receipt without the note, then `editMessageText` to inject the note. The renderer's snapshot tests already accommodate the "no note" branch.
- For `assistantChatCapability` tool-result routing, the structured-vs-prose detection is heuristic. If the heuristic mis-routes more than ~5% of chats in QA, add an explicit `tool.result.kind: "structured" | "prose"` field to the `IToolProvider.execute` contract.
