# Stock-open LLM tool — Backend implementation plan (rev 2)

**Status:** ready to implement
**Date:** 2026-05-05
**Supersedes:** rev 1 of this file (delegated through `IIntentUseCase.parseAndExecute` — wrong target; see "What changed from rev 1" at the bottom).
**Scope:** add a single `stock_open` LLM tool so natural-language messages like "buy $10 of AAPL" route into the existing `/stock` capability and emit the standard mini-app modal. Read-only stock tools (`get_stock_quote`, `get_stock_positions`) and the `/stock buy|short|close|sl|tp` slash command stay untouched.
**Out of scope:** `stock_close` / `stock_set_exits` LLM tools (deferred — disambiguation forces a `tradeHash` the LLM cannot reliably produce). Aster on-chain min-notional pre-check (user is sizing above venue minimum manually for testing).

---

## Architecture (the part rev 1 got wrong)

The `/stock` flow lives behind `ICapabilityDispatcher`, not behind `IIntentUseCase.parseAndExecute`:

- `parseAndExecute` (`be/src/use-cases/implementations/intent.usecase.ts:53`) is the **dynamic-tool / IntentParser → solverRegistry** pipeline used by `/send`. It returns `IntentExecutionResult { calldata, humanSummary, requiresConfirmation }` and never invokes a Capability.
- The capability layer is reached through `ICapabilityDispatcher.handle({ userId, channelId, input })` — see `be/src/adapters/implementations/input/telegram/handler.ts:93,129`. The dispatcher matches the input against the `CapabilityRegistry`, fills in `ctx.emit` from the renderer, and runs `capability.collect → run`. **`channelId` is required** because the renderer needs it to send the mini-app artifact back to the right Telegram chat.
- `INTENT_ACTION.STOCK_TRADE` exists in the enum (`be/src/helpers/enums/intentAction.enum.ts:7`) but has zero consumers in `intent.usecase.ts` or any solver. It is reserved-but-unused; no parser/solver path will route a stock action.

Therefore the new tool **must call `ICapabilityDispatcher.handle(...)` directly** with `{ kind: "text", text: "/stock buy $X SYM" }`. To do that it needs `channelId`, which is not currently plumbed into the LLM tool registry.

This plan picks the **plumb-channelId-through-IChatInput** option. Alternatives considered and rejected:

- *Spawn-marker on `IToolOutput`:* tool returns `{ success, spawn: {...} }` and `AssistantChatCapability` re-dispatches using its own `ctx.channelId`. Avoids the interface change but adds a new contract to `IToolOutput` that other tools could misuse, and makes the spawn happen *after* the LLM round instead of inside it (so the LLM's final-round reply can't reflect actual sign outcome).
- *Direct call into `StockCapability`:* the capability requires a `CapabilityCtx` with `emit`. Constructing one outside the dispatcher means duplicating `CapabilityDispatcher.handle`'s emit-binding + pending-store logic. Not worth it for one tool.

Plumbing `channelId` through `IChatInput` is mechanical (~15 LOC across 3 files) and matches the way other ctx fields already flow (`userId`, `conversationId`).

### Recursive dispatch — safe but worth knowing

When the LLM calls `stock_open`, the tool re-enters `ICapabilityDispatcher.handle` for the **same `channelId`** that's currently mid-dispatch (the outer dispatch is running `AssistantChatCapability`). This is safe because:

- `AssistantChatCapability` doesn't write pending state, so the inner dispatch won't see a stale `prior` it could clobber.
- The inner dispatch matches `StockCapability` on the `/stock` slash and runs it to completion (mini-app emit → `signing.waitFor` → success/fail card).
- The renderer for the inner dispatch is the same `TelegramArtifactRenderer` instance — both dispatches push to the same chat in order: first the mini-app, then the outer LLM's final-round text reply ("Tap above to confirm…").

### Blocking — also worth knowing

`StockCapability.runOpen` awaits `signing.waitFor` with `SIGN_WAIT_TIMEOUT_MS = 10 * 60 * 1000`. The tool call therefore blocks the LLM round for up to 10 minutes while the user is in the mini-app. The user sees the Telegram "typing…" indicator the whole time. This matches the slash-command UX (telegram-handler's outer `dispatcher.handle` blocks the same way) — acceptable for v1, but call it out in the post-merge status note so future contributors don't try to fire-and-forget.

---

## File-by-file changes

### P1 — Add `channelId` to `IChatInput`

**Edit** `be/src/use-cases/interface/input/assistant.interface.ts`:

```ts
export interface IChatInput {
  userId: string;
  conversationId?: string;
  message: string;
  imageBase64Url?: string;
  /**
   * The input adapter's channel id (e.g. Telegram chat id stringified). Threaded
   * through to the LLM tool registry so capability-bound tools (stock_open) can
   * re-dispatch into ICapabilityDispatcher.handle, which binds the renderer's
   * emit to the correct user-facing channel.
   */
  channelId: string;
}
```

This is a breaking change to `IChatInput`. Two call sites to update:

1. `be/src/adapters/implementations/output/capabilities/assistantChatCapability.ts:62` — pass `ctx.channelId` from the `CapabilityCtx`.
2. Any other caller of `assistantUseCase.chat(...)`. Grep result at the time of writing: `assistantChatCapability.ts` is the only one. `httpQuery.tool.ts` calls `orchestrator.chat`, not `assistantUseCase.chat` — different interface, leave alone.

### P2 — Thread `channelId` through `AssistantUseCaseImpl` and the registry factory

**Edit** `be/src/use-cases/implementations/assistant.usecase.ts`:

- `chat(input: IChatInput)` already accepts the new field via the interface change.
- Change `registryFactory: (userId, conversationId) → ...` to `(userId, conversationId, channelId) → ...` in the constructor field type.
- Inside `chat()`, replace `await this.registryFactory(input.userId, conversationId)` with `await this.registryFactory(input.userId, conversationId, input.channelId)`.

**Edit** `be/src/adapters/inject/assistant.di.ts:452` — the `registryFactory` closure inside `getUseCase()`:

```ts
const registryFactory = async (
  userId: string,
  conversationId: string,
  channelId: string,
): Promise<IToolRegistry> => {
  const r = new ToolRegistryConcrete();

  // ... existing registrations unchanged ...

  // stock_open — re-enters the capability dispatcher with /stock buy|short.
  // Lazily resolves the dispatcher to break the construction-time cycle:
  //   getCapabilityDispatcher → getUseCase (this factory) → getCapabilityDispatcher
  // is safe because this lambda runs per-message, after both are constructed.
  const dispatcher = await this.getCapabilityDispatcher();
  if (dispatcher) {
    r.register(
      new StockOpenTool({
        userId,
        channelId,
        dispatcher,
        isDisabled: () => this.isStockCapabilityDisabled(),
      }),
    );
  }

  return r;
};
```

The `dispatcher` may legitimately be `undefined` when the bot isn't yet attached (workers, http-only entry points). In that case skip registration silently — same policy as the existing `if (this._signingRequestUseCase) { ... }` guards.

**Important:** `getCapabilityDispatcher` must be called **lazily inside the per-message factory**, not at construction. The construction-order chain is:

1. boot → `getCapabilityDispatcher()` runs first
2. inside it, `this.getUseCase()` constructs `AssistantUseCaseImpl` with the `registryFactory` *closure* (no dispatcher reference yet)
3. `getCapabilityDispatcher` finishes, memoizes `_capabilityDispatcher`
4. user sends a message → `registryFactory(...)` fires → `await this.getCapabilityDispatcher()` returns the memoized instance ✅

Do NOT pull `dispatcher` into a `const` outside the lambda — that would attempt resolution during step 2 and reach the unfinished dispatcher.

### P3 — New tool

**Create** `be/src/adapters/implementations/output/tools/stockOpen.tool.ts`:

```ts
import { z } from "zod";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { ICapabilityDispatcher } from "../../../../use-cases/interface/input/capabilityDispatcher.interface";

const log = createLogger("stockOpenTool");

const InputSchema = z.object({
  side: z
    .enum(["buy", "short"])
    .describe("'buy' opens a long position, 'short' opens a short position."),
  symbol: z
    .string()
    .regex(/^[A-Za-z]{1,5}$/, "1–5 letter ticker, e.g. AAPL")
    .describe("Stock ticker. Supported: AAPL, AMZN, TSLA, NVDA, GOOG, META."),
  amountUsd: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "Decimal USD amount, e.g. '10' or '12.5'")
    .describe(
      "Notional collateral in USD. Funded from the user's home-chain USDC balance.",
    ),
});

export interface StockOpenToolDeps {
  userId: string;
  channelId: string;
  dispatcher: ICapabilityDispatcher;
  /** Soft-disable gate flipped when verifyStockCapability() fails at boot. */
  isDisabled: () => boolean;
}

export class StockOpenTool implements ITool {
  constructor(private readonly deps: StockOpenToolDeps) {}

  definition(): IToolDefinition {
    return {
      name: "stock_open",
      description:
        "Open a tokenized-stock position (long or short) on Aster (BSC). " +
        "Supported symbols: AAPL, AMZN, TSLA, NVDA, GOOG, META. " +
        "The user is shown a mini-app confirmation modal before any signing — " +
        "this tool does NOT execute silently. " +
        "Use this when the user asks to buy, long, or short a stock by USD notional " +
        "(e.g. 'buy $10 of AAPL', 'long $25 TSLA', 'short $50 of NVDA'). " +
        "For closing or setting SL/TP, instruct the user to use /stock close, " +
        "/stock sl, or /stock tp — those flows need disambiguation that this tool " +
        "cannot provide.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    if (this.deps.isDisabled()) {
      log.warn(
        { step: "failed", userId: this.deps.userId, reason: "stocks-disabled" },
        "stock-open rejected — capability soft-disabled",
      );
      return {
        success: false,
        error: "Stock trading is temporarily unavailable. Please try again later.",
      };
    }

    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      log.warn(
        { step: "failed", userId: this.deps.userId, reason: "schema-parse-failed" },
        "stock-open input rejected",
      );
      return {
        success: false,
        error: `Invalid stock_open arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }

    const { side, symbol, amountUsd } = parsed.data;
    const text = `/stock ${side} $${amountUsd} ${symbol.toUpperCase()}`;

    log.info(
      { step: "started", userId: this.deps.userId, side, symbol: symbol.toUpperCase(), amountUsd },
      "stock-open dispatching to /stock capability",
    );

    try {
      const result = await this.deps.dispatcher.handle({
        userId: this.deps.userId,
        channelId: this.deps.channelId,
        input: { kind: "text", text },
      });
      log.info(
        { step: "succeeded", userId: this.deps.userId, handled: result.handled },
        "stock-open dispatch returned",
      );
      // The dispatcher already rendered the user-facing artifact (mini-app modal,
      // success/failure card, etc.) via the renderer. The string we return here
      // only goes back to the LLM as the tool result — keep it short so the
      // model writes a concise closing reply instead of paraphrasing.
      return {
        success: true,
        data: result.handled
          ? `Stock ${side} flow started for $${amountUsd} ${symbol.toUpperCase()} — the user has been shown a confirmation modal.`
          : `Could not start the ${side} flow for ${symbol.toUpperCase()}.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, userId: this.deps.userId, side, symbol },
        "stock-open dispatch threw",
      );
      return { success: false, error: msg };
    }
  }
}
```

**Why this shape:**

- **Constructor takes a deps object**, not positional args. The four fields don't have a canonical order and the existing read-only tools (`GetStockPositionsTool`) already pass deps positionally as `(userId, getStockUseCase, isDisabled)` — neither convention dominates, so go with the slightly more readable object form for new tools.
- **`isDisabled()` is checked inside `execute()`** to match the read-only sibling tools (`GetStockQuoteTool` / `GetStockPositionsTool`), which surface a friendly error instead of hiding when the gate flips. Hiding from the registry would mean the LLM only sees `stock_open` if `isDisabled()` was false at the moment the registry was built; the in-execute check honours flips during the process lifetime. (Rev 1 picked the hide-on-disabled path; this rev reverses that decision to match siblings.)
- **No try/catch around the dispatcher call's renderer side-effects** — the dispatcher's own log scope (`capabilityDispatcher`) and the capability's own log scope (`stockCapability`) already carry detailed error metadata. The tool-scope catch only fires for unexpected throws (e.g. capability registration missing) and logs once.

### P4 — No change to `SystemToolProviderConcrete`

The new tool is registered directly in `registryFactory` (alongside `ExecuteIntentTool`, `WebSearchTool`, `GetPortfolioTool`), not through `SystemToolProviderConcrete.getTools()`. Rationale:

- `SystemToolProviderConcrete` is constructed once per process (`assistant.di.ts:727`). Its `getTools(userId, conversationId)` interface doesn't carry `channelId` and shouldn't — the only execution-side stock action is `stock_open` and its dispatcher dependency is fundamentally per-message-channel.
- Adding `channelId` + `ICapabilityDispatcher` to `ISystemToolProvider` would force every consumer of that interface (today only one, but the abstraction is for future input adapters) to plumb a dispatcher through. Premature.
- Registering `stock_open` in `registryFactory` keeps the per-message deps (`channelId`, `dispatcher`) co-located with the only place they're available.

### P5 — Documentation

**Edit** `be/src/adapters/implementations/output/aster/status.md`. Under "## Conventions", **replace** the "Read-only agent tools" bullet:

> **Agent tools.** `get_stock_quote` and `get_stock_positions` are read-only. `stock_open` is the one execution-side tool — it builds a `/stock buy|short …` slash and re-enters the capability dispatcher, so the user still confirms via the mini-app modal. The agent never bypasses confirmed signing. `/stock close`, `/stock sl`, and `/stock tp` remain slash-command-only (no LLM tool) because they need a position-disambiguation prompt on multi-position users — exposing them as tools would force the LLM to hallucinate a `tradeHash`.

**Append** to the "What ships in Phase 2" section a one-line pointer: "Subsequent change: `stock_open` LLM tool — see `be/constructions/2026-05-05-stock-open-llm-tool.md`."

**Edit** `be/src/adapters/implementations/output/capabilities/status.md`. Add a new dated entry at the **top** of the file (existing convention — newest first):

```
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
```

---

## Test plan

Manual, in this order — each gate must pass before the next.

1. **Slash-command sanity** (rules out an unrelated `/stock` regression):
   `/stock buy $5 AAPL` (or whatever clears Aster's min notional). Expect: mini-app modal opens, signing flows to success card, position appears in `/positions`. **If this fails, stop and debug `StockCapability` itself before touching this work.**

2. **Type-check the interface change:**
   `cd be && npx tsc --noEmit` after editing `IChatInput` and before editing call sites — confirm the compiler points at `assistantChatCapability.ts:62` as the missing-property site. After fixing, clean.

3. **Tool visibility:**
   Boot with the bot attached, fresh conversation, ask "what can you do with stocks?". Tail backend logs — `assistantUseCase` `step: "history-loaded"` followed by the `tools-loaded` debug line should include `stock_open` in its `tools` array.

4. **Happy-path NL buy:**
   Type "buy $5 of AAPL" (no slash). Expected log sequence:
   - `stockOpenTool { step: "started", side: "buy", symbol: "AAPL", amountUsd: "5" }`
   - `capabilityDispatcher { step: "capability-invoke", capabilityId: "intent_stock" }` (the *recursive* dispatch — verify the channelId matches the outer dispatch in the same line)
   - `stockCapability { step: "started" }` then `step: "quoted"`
   - Mini-app modal appears in the user's chat with the "Buy $5 of AAPL" preview.
   - User signs → `stockCapability { step: "succeeded" }` → success result-card
   - `stockOpenTool { step: "succeeded", handled: true }`
   - LLM final-round reply ("Done — your AAPL long is open." or similar) renders after the success card.

5. **Short variant:**
   "short $5 of TSLA" → tool emits `side: "short"`. Same log sequence with `side: "short"` and a Short success card.

6. **Unsupported symbol:**
   "buy $5 of XYZ" → schema accepts (regex passes), tool dispatches → capability throws `unsupported symbol XYZ` → `interpretError` returns a friendly card. Verify no double-log of the same error from both `stockOpenTool` (single warn at `succeeded` with `handled:true`) and `stockCapability` (error at the boundary).

7. **Soft-disable:**
   Force `_stockCapabilityDisabled = true` (e.g. break the boot probe temporarily). Restart with bot attached. Ask "buy $5 AAPL" — the LLM still sees `stock_open` in the registry, but `execute()` returns the `stocks_unavailable` error string. The LLM should relay that to the user. Confirm no `capabilityDispatcher` invocation log fires for `intent_stock` on this turn.

8. **Read-only tools still work:**
   "what's the price of AAPL?" → still routes to `get_stock_quote`.
   "show my positions" → still routes to `get_stock_positions`.

9. **Worker / non-bot entry point:**
   Run the assistant use case from a context where the bot is not attached (`workerCli.ts` or an HTTP-only path). Confirm `getCapabilityDispatcher()` returns `undefined`, `stock_open` is not registered, `tsc --noEmit` clean, and the worker doesn't crash.

10. **Final type-check + lint:**
    `cd be && npx tsc --noEmit` clean.

---

## Failure modes to watch in production

- **LLM picks `stock_open` for ambiguous text** ("I want to buy some shares" with no symbol). Schema requires `symbol` and `amountUsd`; the LLM either asks the user to clarify or hallucinates values. Hallucinated symbols hit the `unsupported symbol` branch and surface a friendly card. Acceptable.
- **Min-notional revert.** `buildOpenPlan` does not pre-check Aster's minimum collateral; sub-minimum amounts revert at `openMarketTrade` and surface via the recovery flow. **Out of scope** per the user's note. Worth a follow-up.
- **Spend-delegation missing.** If the user has no home-chain USDC delegation row, the bridge leg redirects to onboarding. Same behavior as the slash command.
- **10-minute mini-app timeout blocks the LLM round.** Documented above. If the user closes the mini-app and walks away, the tool will eventually return `signing.waitFor` timeout → `stockCapability` returns a "timed out" failure card → the tool returns `success:true, handled:true` (the dispatch *did* run; it's the user that abandoned). The LLM's final reply will reflect that with a "looks like you didn't confirm in time" sentence — acceptable.
- **Recursive dispatch deadlock.** Not possible with the current design — `AssistantChatCapability` doesn't write pending state, and `CapabilityDispatcher.handle` is re-entrant. If a future capability adds locking on `channelId`, that lock MUST be re-entrant per dispatch-id or it will deadlock with this tool.

---

## Follow-ups (intentionally NOT in this plan)

- `stock_close` LLM tool. Blocked on disambiguation (see scope note above). When opened, gate it behind a `resolvePositionForSymbol` call inside `execute()` and return a friendly "you have multiple AAPL positions, type `/stock close AAPL` to pick one" string when `kind: "many"`.
- `stock_set_exits` LLM tool. Same disambiguation concern, plus sl/tp price-side validation.
- Aster on-chain min-notional pre-check inside `StockUseCaseImpl.buildOpenPlan` (returns a typed `amount_too_low` error from `errorCatalog`).
- `getMarketInfos` ABI re-verification against verified BscScan source. Carried over from Phase 1 status note; orthogonal to this plan but a real risk for sizing math on user trades.
- `INTENT_ACTION.STOCK_TRADE` cleanup — either wire it through the parser/solver pipeline (would replace this tool with a fully-natural-language route) or delete the enum value. Audit the parser fixtures before deleting.

---

## Estimated effort

~50 LOC in one new file (`stockOpen.tool.ts`), ~5 LOC of interface change (`assistant.interface.ts`), ~8 LOC in `assistant.usecase.ts`, ~2 LOC in `assistantChatCapability.ts`, ~12 LOC in `assistant.di.ts`, ~30 LOC of status.md updates across two files. No DB migration. No env knob. No FE change.

---

## What changed from rev 1

Rev 1 delegated the new tool through `IIntentUseCase.parseAndExecute`, mirroring `transferErc20.tool.ts`. That was wrong: `parseAndExecute` runs the dynamic-tool/solver pipeline and never reaches a Capability. `/send` works through that pipeline because it's solver-based; `/stock` lives in the capability layer. Calling `parseAndExecute("/stock buy $5 AAPL")` would have either rejected as low-confidence or misrouted to the swap solver.

Rev 2:

- Calls `ICapabilityDispatcher.handle(...)` directly (the path the Telegram input handler uses).
- Plumbs `channelId` through `IChatInput → AssistantUseCaseImpl → registryFactory → tool` so the renderer routes the mini-app to the right chat.
- Documents the construction-cycle resolution (`getCapabilityDispatcher → getUseCase → registryFactory`) and why the dispatcher must be lazy-resolved inside the per-message lambda.
- Aligns the soft-disable policy with the read-only sibling tools (in-execute friendly error, not registry hiding).
- Adds a status.md entry to the capabilities folder, not just the aster adapter folder.
- Flags `INTENT_ACTION.STOCK_TRADE` as reserved-but-unused with explicit follow-up guidance.
- Calls out the recursive-dispatch and 10-minute-blocking semantics so future contributors don't break them by accident.
