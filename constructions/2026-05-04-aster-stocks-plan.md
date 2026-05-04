# Aster tokenized stocks — Backend plan

**Status:** proposal
**Date:** 2026-05-04
**Author:** Claude (planning session)
**Scope:** backend only — see FE companion at `fe/privy-auth/constructions/2026-05-04-aster-stocks-plan.md`

---

## Goal

Let an Avalanche-onboarded user buy / short / close tokenized US stock perpetuals (AAPL, AMZN, GOOG, META, NVDA, TSLA) by typing a single command in Telegram, signing nothing past onboarding. Aster's 1001x Diamond on **BSC** is the v0 venue. Everything else is the existing `/swap` autosign pattern.

User-facing surface (v0):

| Command | Effect |
|---|---|
| `/stock buy $100 AAPL` | Open long, 1x leverage, $100 notional collateral |
| `/stock short $100 TSLA` | Open short, 1x leverage |
| `/stock close NVDA` | Full close (no partial) |
| `/stock sl AAPL 150` | Set stop-loss on the AAPL position |
| `/stock tp AAPL 220` | Set take-profit on the AAPL position |
| `/positions` | List open Aster positions, LLM-summarised |

Free-text routing is handled by the existing intent parser; `/stock <verb> ...` slash routing uses the same `triggers.commands[]` mechanism as multi-command capabilities (precedent: `SendCapability`).

---

## Non-negotiables (locked in this session)

1. **BSC-only at the venue layer.** Avalanche stays the user's home chain. The vendor lock to BSC lives **only** inside `AsterDiamondClient` (the adapter). Use-cases and ports must remain chain-agnostic — we'll swap Aster out later.
2. **Hexagonal architecture preserved.** Three new ports (below); use-cases never import from `aster/`.
3. **Determinism over LLM.** LLM is used for intent classification and schema fill (existing pipeline). Every other step — chain selection, sizing math, pair-address lookup, position disambiguation — is hardcoded logic.
4. **One mini-app session per `/stock` action**, autosigned, multi-step via `miniAppRequestCache.store(...)` + `?after=<prev>` chaining (existing convention).
5. **Cross-chain leg is non-optional and bundled.** A `/stock buy` is always: Avax→BSC swap → approve → open. Close is always: close → BSC→Avax swap (proceeds returned home).
6. **1x leverage only in v0.** Hardcoded — not LLM-resolved, not user-configurable.
7. **`broker=0` by default, configurable via `ASTER_BROKER_ID` env** for future revenue share.
8. **Stranded-funds policy on cross-chain failure: swap back to Avalanche.** If the destination tx (`openMarketTrade`) reverts after the inbound bridge succeeded, the capability auto-issues a return Relay swap (USDC.bsc → USDC.avax) before raising the user-facing failure. v0: best-effort, single retry. Document the outcome in the Telegram failure message.

---

## Architecture

### New ports (`use-cases/interface/output/`)

All of these live under a new subdir `output/stocks/` to mirror `output/yield/`.

```
output/stocks/
├── stockBrokerProvider.interface.ts    # IStockBrokerProvider — open/close/setExits, vendor-agnostic
├── stockPositionsProvider.interface.ts # IStockPositionsProvider — read user positions
├── stockPriceOracle.interface.ts       # IStockPriceOracle — mark price + fee/slippage hints
└── stockPair.interface.ts              # IStockPairRegistry — symbol → pairBase address mapping
```

**`IStockBrokerProvider`** — what use-cases see:

```ts
interface IStockBrokerProvider {
  buildOpenPositionTx(p: OpenPositionParams): Promise<UnsignedTx[]>; // [approve?, openMarketTrade]
  buildClosePositionTx(p: ClosePositionParams): Promise<UnsignedTx[]>; // [closeTrade]
  buildSetExitsTx(p: SetExitsParams): Promise<UnsignedTx[]>; // [updateTradeTpAndSl]
  // chainId tells callers where the txs target (BSC today)
  readonly venueChainId: number;
  readonly collateralToken: { address: `0x${string}`; decimals: number; symbol: string };
}
```

`UnsignedTx` is the existing `{ to, data, value }` shape `manifestSolver/stepExecutors` already emits.

**`IStockPositionsProvider`**:

```ts
interface IStockPositionsProvider {
  list(traderAddress: `0x${string}`): Promise<StockPosition[]>;
}
interface StockPosition {
  tradeHash: `0x${string}`;
  symbol: string;          // e.g. "TSLA"
  side: "long" | "short";
  entryPrice: string;      // human-readable, fixed-point off
  markPrice: string;
  collateralUsd: string;
  notionalUsd: string;
  unrealizedPnlUsd: string;
  stopLoss: string | null;
  takeProfit: string | null;
  openedAtEpoch: number;
}
```

**`IStockPriceOracle.markPrice(symbol)`** returns a numeric mark price for sizing math.

**`IStockPairRegistry.resolve(symbol)`** returns the synthetic `pairBase` address used in `OpenDataInput`. Backed by an in-memory map populated at boot from a one-off `pairsV4()` decode (see "Bootstrap & verification" below).

### New adapters (`adapters/implementations/output/aster/`)

```
output/aster/
├── asterDiamond.client.ts          # AsterDiamondClient — viem client wired to BSC, ABI for openMarketTrade/closeTrade/updateTradeTpAndSl
├── asterBrokerProvider.ts          # implements IStockBrokerProvider (uses AsterDiamondClient)
├── asterPositionsProvider.ts       # implements IStockPositionsProvider (TradingReaderFacet.getPositionsV2)
├── asterPriceOracle.ts             # implements IStockPriceOracle (TradingReaderFacet.getMarketInfos)
├── asterPairRegistry.ts            # implements IStockPairRegistry (hardcoded map verified at boot)
├── asterAbi.ts                     # ABI fragments — openMarketTrade, closeTrade, updateTradeTpAndSl, getPositionsV2, getMarketInfos, pairsV4, getPairByBaseV4
└── status.md
```

**Caching:** wrap `AsterPositionsProvider` in `CachedStockPositionsProvider(inner, cache, userId, cfg)` with a **60s TTL** (locked decision) per the `CachedXxxProvider` template. Wrap `AsterPriceOracle` in `CachedStockPriceOracle` with a 15s TTL (price freshness for sizing).

### New use-case (`use-cases/implementations/`)

`stocks.usecase.ts` — `StockUseCaseImpl`. Orchestrates the deterministic sequence; exposes:

```ts
interface IStockUseCase {
  buildBuyPlan(p: BuyPlanInput): Promise<StockExecutionPlan>;
  buildShortPlan(p: ShortPlanInput): Promise<StockExecutionPlan>;
  buildClosePlan(p: ClosePlanInput): Promise<StockExecutionPlan>;
  buildSetExitsPlan(p: SetExitsPlanInput): Promise<StockExecutionPlan>;
  listPositions(userId: string): Promise<StockPosition[]>;
  resolvePositionForSymbol(userId: string, symbol: string): Promise<PositionResolution>;
}
type PositionResolution =
  | { kind: "none" }
  | { kind: "one"; position: StockPosition }
  | { kind: "many"; positions: StockPosition[] };
```

**`StockExecutionPlan`** is the deterministic step list — same shape as Relay's `TxStep[]`. `StockCapability` consumes it and emits `SigningRequestRecord`s exactly like `swapCapability.run`.

### New capability (`adapters/implementations/output/capabilities/`)

`stockCapability.ts` — implements `Capability`. `triggers.commands` includes `/stock`; sub-verb (`buy`/`short`/`close`/`sl`/`tp`) parsed deterministically from the message before falling back to the schema compiler. `triggers.callbackPrefix = "stock"`.

Free-text path: schema compile produces `{ verb, symbol, amountUsd?, price? }`; capability picks the right `IStockUseCase` method based on `verb`.

A separate `positionsCapability.ts` (or extend `portfolioUseCase`) owns `/positions`. It calls `IStockPositionsProvider.list(SCA)` and renders Markdown; the chat capability's tool-call loop summarises into a paragraph.

---

## The execution plan (deterministic step lists)

### Buy / short

1. **Resolve mark price** — `IStockPriceOracle.markPrice(symbol)`. Used only for the preview message shown to the user; the on-chain `price` field is filled with this mark, the protocol's slippage policy is the on-chain guardrail.
2. **Sizing.** v0: `notionalUsd = amountUsd`, `collateralUsd = amountUsd`, `leverage = 1x`. `qty` (Aster's 1e10 fixed-point) is computed from `notionalUsd / markPrice`. **No LLM here** — pure math.
3. **Swap leg (Relay).** `RelaySwapTool`-style call: USDC.avax → USDC.bsc, **exact-in `amountUsd`**. v0 simplification — slippage on the swap leg means the user might receive slightly less USDC.bsc than `amountUsd`; we proceed with whatever lands and `amountIn` to the Diamond is set from the actual delivered balance read post-swap. (Slippage handling improvement is out of scope for v0; tracked in backlog.)
4. **Approve leg.** If `tokenAllowance(USDC.bsc, SCA, Diamond) < amountIn`, emit an `approve(Diamond, type(uint256).max)` UserOp. Otherwise skip.
5. **Open leg.** `openMarketTrade(OpenDataInput{ pairBase, isLong, tokenIn=USDC.bsc, amountIn, qty, price=mark, stopLoss=0, takeProfit=0, broker=ASTER_BROKER_ID })`.

Each of (3), (4), (5) is a `SigningRequestRecord`. Step 3 emits `mini_app`; steps 4–5 are stored via `miniAppRequestCache.store(...)`. The FE's `SignHandler.fetchNextRequest` chains them. This is the same pattern as `swapCapability.run`.

**Spend bookkeeping** (per the 2026-04-28 convention): tag the **last step that moves user funds** with `tokenAddress` + `amountRaw`. For buy/short, that's step 3 (Relay swap of USDC.avax) — the open leg consumes USDC.bsc which is not in `token_delegations`. Same as `swapCapability` does today.

### Close

1. **Position lookup.** `resolvePositionForSymbol(userId, symbol)` runs the disambiguation rules (one→auto, many→inline keyboard, none→reject). Multi-position picker emits a `keyboard` artifact with one button per position; callback data carries the `tradeHash`.
2. **Close leg.** `closeTrade(tradeHash)` UserOp on BSC.
3. **Return swap leg.** Read post-close USDC.bsc balance on the SCA; Relay quote USDC.bsc → USDC.avax exact-in for that balance; emit UserOp.

Steps 2 + 3 are autosigned in one mini-app session.

### SL / TP

1. **Position lookup** — same disambiguation.
2. **`updateTradeTpAndSl(tradeHash, stopLoss, takeProfit)`** UserOp on BSC.

For partial updates (only setting SL or only TP), pass through the position's existing value for the unchanged leg — `IStockPositionsProvider` already exposes both fields.

### Stranded-funds recovery (locked decision: swap back)

If step (5) of buy/short reverts:
- Read SCA balance of USDC.bsc.
- Issue a Relay swap USDC.bsc → USDC.avax exact-in.
- User-facing reply: "Open trade failed (reason). Your $100 has been returned to Avalanche." — never silently leave funds stranded.

Implementation: wrap the open leg's `SigningResolutionEvent` handler in `stockCapability` to detect a revert and synthesise the recovery `SigningRequestRecord`. This sits inside the same mini-app session.

If the recovery swap also fails: emit a structured failure message with the BSC tx hash and explorer link; surface as `error: "stock-stranded-funds"` so support can intervene. Loyalty award is skipped on any failure path.

---

## DI wiring (`adapters/inject/assistant.di.ts`)

Lazy singletons added:
- `getAsterDiamondClient()` — viem client on BSC; reads `BSC_RPC_URL` from chain config.
- `getStockBrokerProvider()` — `AsterBrokerProvider(asterDiamondClient, asterPairRegistry, brokerEnv)`.
- `getStockPositionsProvider()` — `CachedStockPositionsProvider(AsterPositionsProvider(asterDiamondClient), cache, userId, { ttlSec: 60 })`. Per-user-bound via factory, like transfer history.
- `getStockPriceOracle()` — `CachedStockPriceOracle(AsterPriceOracle(asterDiamondClient), cache, { ttlSec: 15 })`.
- `getStockPairRegistry()` — `AsterPairRegistry()` (verifies pair list against `pairsV4()` at boot, throws on mismatch — fail-closed).
- `getStockUseCase()` — `StockUseCaseImpl({ broker, positions, oracle, pairs, relaySwapTool, userProfileRepo, signingRequest, miniAppRequestCache, log })`.
- `getStockCapability()` — `StockCapability({ stockUseCase, signingRequest, miniAppRequestCache, log })`.

Capability registered in `getCapabilityDispatcher()`.

---

## Chain config additions (`helpers/chainConfig.ts`)

Add **BSC mainnet** to `CHAIN_REGISTRY` (chainId 56). Required:

- viem chain
- `defaultRpcUrls: string[]` (must include at least one public RPC; `https://bsc.publicnode.com` confirmed reachable from our env during this planning session)
- `ankrBlockchain: "bsc"` (Ankr supports it — keeps portfolio + transfer history working when stocks land in the SCA)
- USDC.bsc registry entry (18 decimals on BSC — note this differs from Avax's 6)
- Native BNB synthesised automatically via `getNativeTokenInfo`

**Avalanche stays the home chain.** No change to `CHAIN_ID` env default.

---

## Cross-chain delegation (locked: eager onboarding)

Onboarding currently grants a session key + `tokenDelegations` on Avalanche. We extend it to **also** install the same session key on BSC at onboarding time:

- The SCA address is identical on BSC (same CREATE2; AA constants from `helpers/aaConfig.ts` already in lockstep with FE).
- The SCA on BSC is **not yet deployed** — first UserOp on BSC will deploy it via the bundler's init-code flow (same as Avalanche's first-tx behaviour).
- Session-key validator install: piggyback on the existing onboarding `delegationBuilder` flow. This is mostly a FE concern — see the FE companion plan for the actual signature collection.
- BE: extend `IDelegationStore` / `pending_delegations` to be chain-aware (already keyed on `sessionKeyAddress`; we add `chainId`). `/delegation/grant` and `/delegation/approval-params` accept an explicit `chainId` query param, defaulting to `CHAIN_ID` env to preserve existing behaviour.
- `tokenDelegations` rows are already per-chain via the token's `chainId`; USDC.bsc gets its own row at onboarding.

If a user onboarded **before** this feature shipped, they have no BSC delegation. First `/stock` invocation triggers a one-time delegation grant flow on BSC inside the same mini-app session (the FE's existing `OnrampHandler`/`ApproveHandler` wiring handles the modal). Document this explicitly in the user-facing copy.

---

## Database changes

No new tables. Reuse:
- `user_profiles.smartAccountAddress` — same SCA on BSC.
- `token_delegations` — add USDC.bsc row at onboarding.
- `intents` / `intent_executions` — Aster open/close/exits are intents; tag `chain_id = 56` and a new `intentAction` enum value `STOCK_TRADE`.
- `loyalty_action_types` — three new rows: `stock_open_long`, `stock_open_short`, `stock_close`. Pricing follows the `actionDefaults` fallback per the 2026-04-25 loyalty plan.

If we later need historical position records, add a `stock_positions_snapshot` table — explicitly out of scope for v0 (positions live on-chain; we read live).

---

## HTTP API additions

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/stocks/positions` | Return cached `StockPosition[]` for the authenticated user. Maps to `IStockPositionsProvider.list(SCA)`. `Cache-Control: private, max-age=60`. |
| `GET` | `/stocks/pairs` | Return verified pair list (symbol → pairBase). 1h CDN cache. |
| `GET` | `/stocks/quote?symbol=&amountUsd=` | Return mark price + computed `qty` + estimated USDC needed (preview only). |

`/positions` endpoint is *not* renamed — `/stocks/positions` is its own surface so the agent can call it as a tool independently of the broader portfolio view.

New agent tool (`SystemToolProviderConcrete`): `get_stock_positions` — returns Markdown table, used by `assistantChatCapability` to fulfil "/positions" in plain language and arbitrary chat ("how is my Tesla doing?").

---

## Configuration

New env vars (per the no-inline-config rule):

| Variable | Default | Purpose |
|---|---|---|
| `ASTER_DIAMOND_ADDRESS_BSC` | `0x1b6F2d3844C6ae7D56ceb3C3643b9060ba28FEb0` | Pinned. Diamond proxy on BSC. |
| `ASTER_BROKER_ID` | `0` | Pass-through to `OpenDataInput.broker`. Set later for revenue share. |
| `ASTER_POSITIONS_TTL_SEC` | `60` | `CachedStockPositionsProvider` TTL. |
| `ASTER_PRICE_TTL_SEC` | `15` | `CachedStockPriceOracle` TTL. |
| `BSC_RPC_URL` | (chain config default) | Override BSC RPC. Comma-separated fallbacks supported via the standard `RPC_URL_FALLBACKS` shape. |
| `STOCK_RECOVERY_ENABLED` | `true` | Master switch on the auto-bridge-back behaviour. Set `false` to disable in incidents. |

All env reads consolidated into `helpers/env/asterEnv.ts`.

---

## Bootstrap & verification

`scripts/verify-aster-pairs.ts` — one-off (matches the precedent of `scripts/verify-sca-derivation.ts`):

1. Call `pairsV4()` on the BSC Diamond.
2. Decode using the verified `PairsManagerFacet` ABI (pulled from the source on BscScan; commit a copy in `asterAbi.ts`).
3. Print the symbol → pairBase mapping.
4. Diff against the hardcoded mapping in `asterPairRegistry.ts`. **Must be 100% match before merge.**

`AsterPairRegistry` constructor calls a tiny version of this at boot in production: it re-fetches `pairsV4()` and asserts the hardcoded mapping is still a subset of the live list. If a stock pair has been removed by Aster, fail closed — the capability throws on init and `/stock` becomes unavailable rather than silently routing to a broken pair.

---

## Logging

New scopes (per the convention in CLAUDE.md):

- `stockCapability` — `step` events: `started`, `quoted`, `swap-submitted`, `approve-submitted`, `open-submitted`, `succeeded`, `failed`, `recovery-started`, `recovery-succeeded`, `recovery-failed`.
- `stockUseCase` — plan construction events.
- `asterBrokerProvider` — outgoing tx build (`debug` only — never log `OpenDataInput` raw).
- `asterPositionsProvider` — `choice: "hit"|"miss"`, position count.
- `asterPriceOracle` — same shape.
- `asterPairRegistry` — boot-time verification result, `count`.
- `asterDiamondClient` — `→`/`←` debug for raw RPC calls.

New metadata fields (worth flagging in the capabilities `status.md`): `symbol`, `side`, `tradeHash` (truncated to 12 chars), `markPrice`, `notionalUsd`, `venueChainId`.

**Never log:** raw `OpenDataInput`, broker IDs in production, full `tradeHash` (truncate). Standard privacy rules apply.

---

## Loyalty hooks

Three new action types; awarded fire-and-forget at the *successful* completion of:

- `stock_open_long` — buy
- `stock_open_short` — short
- `stock_close` — close (regardless of P&L)

SL/TP updates do not award points (no funds movement). Stranded-funds recovery does not award points (the open failed).

Register entries in `loyaltyCapability.ts:ACTION_LABELS` and `awardPoints` branches inside `stockCapability` at the resolution point.

---

## Aegis Guard

Stocks debit USDC like everything else. The existing `tokenDelegations` row on USDC.avax covers the **outbound** spend (the swap leg moves USDC.avax). No new delegation bucket needed — Aegis Guard pre-flight check happens once at the start of the buy/short flow against USDC.avax.

The intermediate USDC.bsc leg is fully internal to the SCA and never leaves user custody — it's not subject to a separate budget. Document this in the FE PermissionsSection copy so users aren't confused why "stock spending" doesn't appear as its own bucket.

---

## Phasing

**Phase 1 — Read-only foundation (no user-visible flow):**
- Chain config: BSC entry, USDC.bsc row, Ankr key.
- Ports + adapters: pair registry, price oracle, positions provider (cached).
- `verify-aster-pairs.ts` script + boot verification.
- `GET /stocks/pairs` + `GET /stocks/quote` (no auth required for pairs, Privy auth for quote).
- `get_stock_positions` agent tool — read-only, no execution.

This phase ships value (users can ask "how's TSLA doing today?" and the agent answers) without any signing infra changes.

**Phase 2 — Buy / short:**
- Eager BSC delegation grant in onboarding (FE-led; see FE plan).
- `StockCapability` open paths.
- Cross-chain swap orchestration + recovery branch.
- Loyalty hooks.

**Phase 3 — Close + SL/TP:**
- Close path with return-swap.
- `/stock sl` / `/stock tp` with disambiguation keyboard.
- `/positions` summarised view.

Each phase is independently shippable behind no flag — capability registration is the gate.

---

## Out of scope (v0)

Tracked for future phases; **do not** add to v0:

- Leverage > 1x.
- Partial close.
- Limit orders (`openLimitOrder`).
- Multi-asset collateral (USDT, native).
- Arbitrum venue.
- Aster Pro (off-chain orderbook) integration.
- Funding-rate display, historical P&L, position alerts.
- Slippage-aware sizing on the cross-chain leg (currently exact-in $X with whatever lands on BSC).
- Stranded-funds recovery beyond a single retry.
- Forex / commodities (PAXG) — same Diamond, but separate UX surface; revisit after stocks ship.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Aster delists a stock pair | Boot-time verification fails closed; capability returns `error: "stock-pair-unsupported"` cleanly. |
| Aster oracle returns stale price → revert | Recovery swap brings funds home; surface "try again" with explorer link. |
| BSC RPC outage | `RPC_URL_FALLBACKS` template; `defaultRpcUrls: string[]` already supported by viem `fallback`. |
| Cross-chain bridge stalled | Relay's `intents/status/v2` polling already in our backlog — for v0 we trust Relay's success callback and surface long-pending state via existing UX. |
| First-time BSC user has no delegation | Caught at flow start; capability emits the one-time delegation grant request before the trade. Telegram message explains "approving once for stock trading on BSC." |
| User tries to open a 2nd position in same symbol mid-flight | Aster supports multiple concurrent positions per symbol — disambiguation keyboard handles this on the close/SL/TP side. |
| Diamond contract upgrade changes ABI | We pin `ASTER_DIAMOND_ADDRESS_BSC` to the proxy (which is the upgrade-stable address) and ship ABI fragments only for the selectors we use. Selector breakage shows up in the boot verification before user impact. |

---

## Acceptance criteria

- `verify-aster-pairs.ts` outputs the same mapping `asterPairRegistry.ts` ships with — 100% match — before merge.
- `/stock buy $1 AAPL` (test mode) produces three signing requests, all autosigned, in one mini-app session, ending in an explorer link to the BSC `openMarketTrade` tx.
- `/positions` returns the open AAPL trade within 60s of the open tx confirming.
- `/stock close AAPL` produces two signing requests (close + return swap), and the user's USDC.avax balance reflects the return within ~Relay settlement time.
- All happy-path and recovery paths emit the expected `step:` log events with `userId`, `symbol`, and `venueChainId: 56`.
- `STATUS.md` and `output/capabilities/status.md` updated with this feature's conventions before merge.

---

## What this plan does not commit to

- Exact ABI fragments — I'll lift them from the verified `PairsManagerFacet` / `TradingPortalFacet` source on BscScan during implementation. The selectors (`f6d94582 = pairsV4`, `9bd39764 = getPairByBaseV4`, etc.) are confirmed.
- Exact BSC RPC provider — `bsc.publicnode.com` works in our planning environment; production should mirror our existing Avax provider strategy (Ankr primary + public fallbacks).
- Exact Aster broker registration steps — we ship with `broker=0` and revisit when revenue-share is on the roadmap.
