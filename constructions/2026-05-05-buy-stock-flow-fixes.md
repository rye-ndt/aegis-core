# Buy-stock flow — patch plan (BE)

Date: 2026-05-05
Scope: backend-only fixes for the `/stock buy` (open long/short) flow. Close/SL/TP fixes are out of scope unless explicitly listed. Every change must keep `/swap`, `/send`, `/yield`, and the USDC `/buy` onramp working unchanged.

The pair to this plan lives at `fe/privy-auth/constructions/2026-05-05-buy-stock-flow-fixes.md`. P0.3 (classifier) and P0.5 (prompt clarity) are intentionally cross-stack — the BE and FE pieces must merge together.

---

## Priority legend

- **P0** — blocks the `/stock buy` happy path or causes silent fund loss. Fix first.
- **P1** — degrades UX but the trade still completes on the happy path.
- **P2** — defensive; not strictly needed for v0.

Order below is execution order, not severity.

---

## P0.1 — Aegis Guard pre-flight on home USDC (missing today)

**Problem.** Impl plan §P2.5(4) required `checkTokenDelegation` on home-chain USDC at the start of `runOpen`, mirroring `swapCapability`. Today `stockCapability.runOpen` skips it. Users with insufficient (or expired) delegation on USDC get an opaque user-op simulation revert mid-bridge instead of a clean "tap to re-approve" mini-app.

**Files**
- `be/src/adapters/implementations/output/capabilities/stockCapability.ts`
- `be/src/adapters/inject/assistant.di.ts` (DI: pass `tokenDelegationDB` and `pendingIntentStore` into `StockCapabilityDeps`)
- `be/src/use-cases/implementations/aegisGuardInterceptor.ts` (no edit; reuse `checkTokenDelegation`)

**Change**

1. Extend `StockCapabilityDeps`:
   ```ts
   tokenDelegationDB?: ITokenDelegationDB;
   pendingIntentStore?: IPendingIntentStore;
   ```
2. At the top of `runOpen`, before `buildOpenPlan`, run the guard against **home-chain USDC** for the full `amountUsd`. Use `swapCapability.ts:156–195` as the reference — copy the snapshot/persist/reapproval flow verbatim, only changing:
   - `capabilityId` → `"intent_stock"`.
   - `params` → the `StockOpenParams` object (with `kind: "open"`).
3. On `guard.ok === false`, save a resume snapshot keyed on `guard.reapprovalRequest.requestId` and return the reapproval mini-app artifact directly — the existing `signingRequest.usecase.resumePendingIntent` path will re-enter `run()` with the same params after approval.
4. Log `step: "guard-blocked"` and `step: "guard-passed"` at info level — never log token addresses or amounts beyond what already appears.

**Why home USDC only, not USDC.bsc.** The bridge consumes home USDC; USDC.bsc is delivered, not spent from a delegation budget. Tagging on the venue side would require a second delegation grant (P0.4) — guard there is moot until that lands.

**Test plan**
- New user with zero delegation → `/stock buy $5 AAPL` returns the reapproval mini-app, not an Aster revert.
- Approves → resume re-enters `runOpen`, plan rebuilds against the new mark price (`forceRequote`-style is unnecessary; `buildOpenPlan` always re-quotes).
- User with sufficient delegation → no functional change vs. today.

**Scope guard.** Do not change `runClose` or `runExits`. Close path uses no home-chain spend; SL/TP path uses no home-chain spend.

---

## P0.2 — USDC.bsc delegation grant on first /stock open

**Problem.** Today the only delegation grant we issue is for **home-chain** USDC (via `ApprovalOnboarding` at sign-up). When the venue-leg openMarketTrade signs through the BSC session key, the BE has no `token_delegation` row for USDC.bsc. Two breakages:
1. `aegisGuardInterceptor` cannot enforce a budget on the venue spend (acceptable for v0 but documented).
2. More importantly, `signingRequest.usecase` runs `checkTokenDelegation` on every sign request when the request carries a `tokenAddress`. Today we skip tagging USDC.bsc on venue steps to side-step this — but that means the user has *no* per-token spending limit on BSC and any future hardening will be a footgun.

**Decision for v0:** keep venue steps untagged (`step.spendTokenAddress = undefined`) and document this in `output/aster/status.md`. Do **not** add a phantom delegation row.

**Files**
- `be/src/adapters/implementations/output/aster/status.md` — append:
  > Venue-chain (BSC) sign requests are intentionally emitted without `tokenAddress`/`amountRaw` so the signing-request layer skips delegation enforcement. The home-chain USDC spend is the budget anchor; BSC funds are transient (bridged in, opened, closed, returned). When we add a per-token budget on USDC.bsc, ship a `delegation_grant` migration first AND set `spendTokenAddress` on the venue open step.

- `be/src/use-cases/implementations/stock.usecase.ts` — add a one-line code comment at `buildOpenPlan` step #5 referencing the status note. No code change.

**Why this is P0.** Until we explicitly document the gap, anyone touching `signingRequest.usecase.preFlight` will assume we have BSC delegation coverage and will break the venue leg by tightening the guard.

---

## P0.3 — Classifier priority: stock > token onramp

**Problem.** Two surfaces conflate stocks with the USDC onramp:
1. **LLM tool surface.** `route_intent` exposes `INTENT_COMMAND.BUY` (USDC onramp) and `INTENT_COMMAND.STOCK` (Aster). For "buy AAPL", the model can pick BUY → drops the user into an onramp prompt asking how much USDC to deposit.
2. **Slash-command surface.** A user typing `/buy 100 AAPL` reaches `BuyCapability`, which silently treats `100 AAPL` as a malformed amount and re-prompts. Confusing.

**Files**
- `be/src/adapters/implementations/output/tools/routeIntent.tool.ts`
- `be/src/adapters/implementations/output/tools/stockOpen.tool.ts`
- `be/src/adapters/implementations/output/capabilities/buyCapability.ts`
- `be/src/use-cases/interface/output/stocks/stockPair.interface.ts` (no edit; reuse `resolveByQuery`)
- `be/src/adapters/inject/assistant.di.ts` (DI: pass `IStockPairRegistry` into `BuyCapability`)

**Change A — tool descriptions (LLM-side priority).**

`stockOpen.tool.ts.definition().description`:
> Open a tokenized-stock position (long or short) on Aster (BSC). **Use this for ANY user request to buy, long, or short a stock — including phrasings like "buy AAPL", "buy $10 of TSLA", "I want some Apple shares". Do NOT use `route_intent` with `command="/buy"` for stock symbols — `/buy` is the USDC fiat-onramp and is the wrong tool for stocks.** Supported symbols: AAPL, AMZN, TSLA, NVDA, GOOG, META. The user is shown a mini-app confirmation modal before any signing — this tool does NOT execute silently. For closing or setting SL/TP, instruct the user to use /stock close, /stock sl, or /stock tp.

`routeIntent.tool.ts.definition().description` — append a final sentence:
> When `command="/buy"` is the candidate but the user's text mentions a stock symbol (AAPL, TSLA, NVDA, GOOG, META, AMZN, etc.) or words like "stock"/"shares", call `stock_open` instead — `/buy` is for the USDC fiat onramp only.

`routeIntent.tool.ts` `command` enum description (zod `.describe(...)`):
> Slash command for the matching capability. Pick the most specific one. `/buy` is the USDC fiat onramp (deposit address or card payment); never use it for stock symbols — use the `stock_open` tool for stocks.

**Change B — deterministic slash-route reroute.**

In `BuyCapability.collect`, before any other parsing, if the message after `/buy` contains a token that resolves through `stockPairRegistry.resolveByQuery`, return a `terminal` artifact that:
1. Logs `log.info({ step: "rerouted-to-stock", symbol }, "/buy <stock> rerouted")`.
2. Emits a `chat` artifact with text:
   > You typed `/buy AAPL`, which is for buying USDC (the dollar stablecoin). Did you mean to buy a stock? Try `/stock buy $100 AAPL`.
3. Includes an inline keyboard with one button: "Buy 100 USD of AAPL stock" → callback `stock:reroute:<symbol>` (no amount default — re-prompt for amount in stock flow).

Add the matching callback in `stockCapability.handleCallback` for `stock:reroute:<symbol>` that returns `{ kind: "ask", question: "How much USD of <symbol> would you like to buy? Reply with a number, e.g. 50." , state: { stage: "awaiting_amount", symbol } }`. (Reuses an `awaiting_amount` state — add it to `stockCapability` if not present; today it has no resume state since the slash form requires the amount inline.)

**Wire the registry into `BuyCapability`.** Update `assistant.di.ts:791` to pass `getStockPairRegistry()` as a new third constructor arg. If the registry is empty (catalogue not loaded), skip the reroute and let `BuyCapability` continue normally — never block the onramp because the stock crawler is offline.

**Test plan**
- `/buy 100 AAPL` → emits the reroute card, original onramp prompt is not shown.
- `/buy 100` → onramp flow unchanged.
- `/buy` (no arg) → onramp prompt unchanged.
- LLM with `"buy AAPL"` → calls `stock_open` (verify in dev with the Anthropic playback).
- LLM with `"buy $50 USDC with card"` → calls `route_intent` with `/buy` (negative test).

**Scope guard.** Don't touch the onramp's `OnrampHandler`/`OnrampRequest` path. The reroute is a chat-only redirect.

---

## P0.4 — `notifyResolved` branch for `planKind: "recovery"`

**Problem.** Both the post-close return swap (`runClose`) and the open-failure recovery (`emitRecoveryMiniApp`) tag signing records with `planKind: "recovery"`. `notifyResolved.ts` has no branch for this — the user sees the generic "Transaction sent" line instead of "Funds returned to your home chain".

**Files**
- `be/src/helpers/notifyResolved.ts`

**Change**

Locate the `case "succeeded":` branch and add:
```ts
if (record.planKind === "recovery") {
  return {
    chat: {
      kind: "chat",
      parseMode: "Markdown",
      text:
        "*Funds returned.*\n\n" +
        `Your USDC is back on ${CHAIN_CONFIG.name}.` +
        (txHash ? `\n\n[View transaction](${buildExplorerUrl(record.chainId, txHash)})` : ""),
    },
  };
}
```

Mirror the same branch in the failure path:
```ts
if (record.planKind === "recovery" && resolution.status === "rejected") {
  return {
    chat: {
      kind: "chat",
      parseMode: "Markdown",
      text:
        "*Recovery failed.*\n\n" +
        "Funds may still be on the trading venue. Contact support with this " +
        `request id: \`${record.id}\`.`,
    },
  };
}
```

**Test plan**
- Force a recovery success (use `STOCK_RECOVERY_ENABLED=true`, simulate venue-leg revert with a mock broker that throws on the second tx) → user sees "Funds returned." in chat.
- Force a recovery failure → user sees "Recovery failed."

**Scope guard.** No change to non-recovery resolution copy. The branch must check `planKind` BEFORE the generic success/failure path so it never silently shadows other artifacts.

---

## P0.5 — User-facing copy: "you're buying a stock, not a token"

**Problem.** Today the open success card says "You opened a long position on AAPL" but the *preview* (`buildPreview`) only shows "Symbol", "Notional", "Mark", "Leverage". A user who confused AAPL the stock with a hypothetical AAPL token would not realise from the preview that this is a synthetic perp on Aster.

Coupled with the FE counterpart (see FE plan §P0.2), the BE needs to emit explicit "synthetic stock perp" wording in the modal preview.

**Files**
- `be/src/adapters/implementations/output/capabilities/stockCapability.ts`
- `be/src/adapters/implementations/output/capabilities/buildPreview.ts` (no edit; just consumed)

**Change**

Inside `runOpen`, in `previewsForOpen`, **prepend** a `description` field at index 0 (or use the result-card top section if buildPreview supports `subtitle`):

```ts
fields: [
  {
    label: "What this is",
    value:
      "A synthetic AAPL stock position on Aster — settled in USDC on BSC. Not the AAPL company shares; a perp tracking AAPL's price.",
    emphasis: "muted",
  },
  { label: "Symbol", value: plan.symbol, emphasis: "primary" },
  ...
]
```

Adjust the wording per symbol via a tiny lookup if needed; otherwise the generic copy above is fine for v0.

Also update the `/stock` usage hint (line ~1003) to:
> Trade tokenized stock perps on Aster (settled in USDC). Try `/stock buy $100 AAPL` · `/stock short $100 TSLA` · `/stock close NVDA` · `/stock sl AAPL 150` · `/stock tp AAPL 220`.

**Scope guard.** Don't touch `swapCapability` or `sendCapability` previews.

---

## P1.1 — Close → return-swap chaining race

**Problem.** In `runClose`, after the close `executeSignSteps` resolves successfully, we call `buildReturnSwapPlan` then `executeSignSteps({ continueSession: true })`. The FE polls `fetchNextRequest` immediately after `reportTxHash` returns; if it wins the race, it gets `null` and closes the mini-app — the queued return-swap sits in the cache until TTL.

**Files**
- `be/src/adapters/implementations/output/capabilities/stockCapability.ts`
- `be/src/use-cases/implementations/signingRequest.usecase.ts` (READ ONLY — confirm `resolveRequest` ordering)

**Change**

Pre-queue the first return-swap step **before** the close `signing.waitFor` resolves. Two sub-options:

**Option A (minimal):** In `executeSignSteps`, when the loop is on its last step AND `planKind` is undefined (i.e. the primary plan), accept an optional callback `onPenultimateResolved(txHash) → Promise<void>`. Caller uses it to build and queue the next plan synchronously after the BE sees the receipt and BEFORE returning to `runClose`.

**Option B (preferred — narrower):** Inline the logic in `runClose`:
1. Call `buildClosePlan` + `executeSignSteps` for the close.
2. Inside the close `executeSignSteps`, **after** the signing record is resolved with a `txHash` but **before** the function returns, optimistically call `buildReturnSwapPlan` and queue its first step into the cache. Surface the queued requestId on the close result so `runClose` can `signing.waitFor` on it.
3. To avoid coupling, do this in `runClose` instead by calling `buildReturnSwapPlan` **before** `executeSignSteps` returns by re-architecting: split `executeSignSteps` to expose a per-step resolution hook.

Concretely, prefer **Option B** with a hook:

```ts
private async executeSignSteps(opts: {
  ...
  onStepResolved?: (i: number, txHash: string) => Promise<void>;
}): Promise<...> {
  ...
  if (resolution.txHash) {
    txHashes.push(resolution.txHash);
    if (opts.onStepResolved) await opts.onStepResolved(i, resolution.txHash);
    log.info(...);
  }
}
```

In `runClose`:
```ts
let returnPlanForChain: StockExecutionPlan | null = null;
const result = await this.executeSignSteps({
  ctx,
  steps: plan.steps,
  buttonText: "Execute Close",
  promptText: "Tap below to close the position.",
  previews: previewsForClose,
  onStepResolved: async (i, _hash) => {
    if (i !== plan.steps.length - 1) return;
    // Last close step settled — pre-build & cache the first return-swap leg
    // so the FE's fetchNextRequest finds it on the very next poll.
    returnPlanForChain = await this.deps.stockUseCase
      .buildReturnSwapPlan({ userId: ctx.userId })
      .catch(() => null);
    if (returnPlanForChain && returnPlanForChain.steps.length > 0) {
      await this.queueFirstStepIntoCache(ctx, returnPlanForChain.steps[0]!);
    }
  },
});
```

Add a private `queueFirstStepIntoCache` that creates the signing-request record + caches the `SignRequest` and returns the `requestId`. Then continue the existing return-swap loop using `continueSession: true` but starting at i=1 (the first step is already queued).

**Test plan**
- Manual: enable a request-log proxy on the FE, confirm `fetchNextRequest` returns the queued return-swap on the FIRST poll.
- Unit: mock `signing.create`/`miniAppRequestCache.store`; assert order of calls.

**Scope guard.** Don't change open-path `executeSignSteps` semantics — the hook is opt-in. Don't change recovery flow's separate-mini-app session contract.

---

## P1.2 — Slippage / amountIn drift guard

**Problem.** `buildOpenPlan` sizes `qty` from `swap.expectedOutRaw` (Relay's quote estimate). Real delivered USDC.bsc may be lower (post-fee, post-slippage). `openMarketTrade` reverts on `transferFrom(amountIn)` when balance < quote.

**Files**
- `be/src/use-cases/implementations/stock.usecase.ts`
- `be/src/adapters/implementations/output/aster/asterBrokerProvider.ts`

**Change**

Apply a 1% safety haircut on `collateralAmountRaw` before computing `qty1e10` AND before calling `buildOpenPositionTxs`:

```ts
const SLIPPAGE_BPS = 100; // 1%
const haircutRaw = (BigInt(swap.expectedOutRaw) * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
const collateralAmountRaw = haircutRaw.toString();
```

Trade-off documented inline: we open with slightly less notional than the user typed (typically ~1%) — better than reverting. Leftover dust on BSC is recovered by the existing return-swap path on close.

Pull the bps from `ASTER_ENV.openSlippageBps` with default `100`. Add to `asterEnv.ts`.

**Test plan**
- Unit test on `stock.usecase` ensuring haircut is applied to both `qty1e10` and `collateralAmountRaw`.
- Live test: open $10 AAPL → success card shows ~$9.90 notional.

**Scope guard.** Do not haircut the user-facing display ("Notional: $10") — that is the input value. Only the on-chain `amountIn` and `qty` use the haircut.

---

## P2.1 — Mark-price freshness / market-hours gate (defer)

**Problem.** Stock markets close. Aster's oracle may go stale; `markPrice` could return zero or last-known. We pass it as the exact `price` field, which Aster will reject or open at a wrong fill.

**Decision.** Defer to a follow-up. Boot-time `verify-aster-pairs` already detects oracle absence; runtime drift is a separate concern. Add a TODO comment at `stock.usecase.ts:71` referencing this section.

---

## File summary

| Section | Path | Action |
|---|---|---|
| P0.1 | `be/src/adapters/implementations/output/capabilities/stockCapability.ts` | edit `runOpen`, deps |
| P0.1 | `be/src/adapters/inject/assistant.di.ts` | wire `tokenDelegationDB`, `pendingIntentStore` |
| P0.2 | `be/src/adapters/implementations/output/aster/status.md` | append note |
| P0.2 | `be/src/use-cases/implementations/stock.usecase.ts` | comment only |
| P0.3 | `be/src/adapters/implementations/output/tools/routeIntent.tool.ts` | description tightened |
| P0.3 | `be/src/adapters/implementations/output/tools/stockOpen.tool.ts` | description tightened |
| P0.3 | `be/src/adapters/implementations/output/capabilities/buyCapability.ts` | reroute on stock symbol |
| P0.3 | `be/src/adapters/implementations/output/capabilities/stockCapability.ts` | new `stock:reroute:<symbol>` callback + `awaiting_amount` state |
| P0.3 | `be/src/adapters/inject/assistant.di.ts` | pass registry to `BuyCapability` |
| P0.4 | `be/src/helpers/notifyResolved.ts` | recovery branches |
| P0.5 | `be/src/adapters/implementations/output/capabilities/stockCapability.ts` | preview fields + usage hint copy |
| P1.1 | `be/src/adapters/implementations/output/capabilities/stockCapability.ts` | `onStepResolved` hook + pre-queue |
| P1.2 | `be/src/use-cases/implementations/stock.usecase.ts` | haircut |
| P1.2 | `be/src/helpers/env/asterEnv.ts` | `openSlippageBps` |

## After implementing

Update:
- `be/src/adapters/implementations/output/capabilities/status.md` — note the Aegis-Guard pre-flight on `runOpen` and the haircut convention.
- `be/STATUS.md` — note the `/buy <stock>` reroute behaviour under Telegram commands.

Do NOT update `2026-05-04-aster-stocks-impl.md` — it's frozen as the original plan; this doc supersedes it for the listed sections only.

## Quality bar

- Every new branch logs at info/warn with the established `step:` taxonomy. No `console.*`.
- All new env reads go through `asterEnv.ts`; no `process.env.STOCK_*` in capabilities.
- The `/buy` USDC onramp must remain functional for amount-only and "buy with card" paths. The reroute fires only when a stock symbol resolves.
- After P0.1 lands, manual test: existing stock-buy users with sufficient delegation see no behavioural change.
- After P0.3 lands, manual test: `/buy 100` (USDC onramp) and `/buy 100 AAPL` (stock reroute) both behave correctly.
