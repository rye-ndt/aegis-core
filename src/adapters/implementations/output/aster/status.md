# Aster (tokenized stocks) — adapter notes

**Status:** Phase 2 — full read + execute (open / close / SL-TP / recovery + agent tools + HTTP read routes)
**Companion plan:** `be/constructions/2026-05-04-aster-stocks-impl.md`

## What ships in Phase 1

- BSC chain registry entry (`chainConfig.ts:56`) with `relayEnabled: false` —
  intentionally keeps `/swap … to bsc` rejected until Phase 2's UX gate.
- `AsterDiamondClient` — single viem PublicClient pinned to BSC, fan-out via
  `fallback` transport.
- `AsterPairRegistry` — hardcoded stock symbols (AAPL/AMZN/TSLA/NVDA/GOOG/META)
  whose synthetic `pairBase` addresses are filled in at boot via
  `verifyAgainstChain()`. Until verification runs, `resolve()` returns `null`
  for every symbol — fail-closed by design.
- `AsterPriceOracle` + `CachedStockPriceOracle` — mark-price reads via
  `getMarketInfos`, in-memory TTL cache (`ASTER_PRICE_TTL_SEC`, default 15s).
  **Compiled but not exposed on any HTTP route in Phase 1** — the
  `getMarketInfos` ABI struct decode against the live Diamond produced
  sentinel values for some symbols (TSLA returned `2^256-1`; AAPL/NVDA/GOOG/META
  returned `100`; AMZN returned `0`). The `/stocks/quote` route, the agent
  `get_stock_quote` tool, and any caller of the oracle land in Phase 2 once
  the struct is verified against BscScan.
- `AsterBrokerProvider` — has `getCollateralBalance`, `hasApproval`. The
  tx-building methods (`buildOpenPositionTxs`, `buildClosePositionTxs`,
  `buildSetExitsTxs`) throw in Phase 1; they're filled in in Phase 2.

## Conventions

- **Chain id 56 lives in this adapter only.** Per the user-locked constraint,
  the rest of the codebase is chain-agnostic; only `asterBrokerProvider.ts`
  pins `VENUE_CHAIN_ID = 56`. CLAUDE.md's "no inline chain ids elsewhere" rule
  treats this adapter as the chain-config-bound exception.
- **Collateral token address & decimals come from config**, never inlined.
  `AsterBrokerProvider.create(...)` resolves USDC.bsc via
  `getUsdcAddress(56)` + `tokenRegistry.findByAddressAndChain` — fail at
  construction if either is missing. Plan fix #2 (no hardcoded values).
- **18-decimal USDC.bsc.** USDC on BSC has 18 decimals, not 6. Every BigInt
  math path must read decimals from the broker's `collateralToken.decimals`
  field — never hardcode.
- **Soft-fail at boot.** `AssistantInject.verifyStockCapability()` swallows
  any verification error and flips `_stockCapabilityDisabled = true`.
  `/stocks/pairs` and `/stocks/quote` then return 503 with
  `error: "stocks_unavailable"`. The rest of the backend boots cleanly.
  Plan fix #9.
- **Read-only agent tools.** `get_stock_quote` and `get_stock_positions`
  ship in Phase 2 as read tools only. Execution stays gated behind the
  `/stock` capability's confirmed mini-app flow — agents never trigger
  trades directly (fix #10).

## ABI source of truth

`asterAbi.ts` mirrors fragments from
https://bscscan.com/address/0x1b6F2d3844C6ae7D56ceb3C3643b9060ba28FEb0#code
(Diamond proxy — calls route to per-facet verified implementations). When
refreshing, paste the verified output struct verbatim — hand-translating
member order has caused silent decode bugs on similar projects.

## Verification

`npm run verify:aster` runs `scripts/verify-aster-pairs.ts`. Required to pass
in CI before any merge that touches `asterAbi.ts` or `asterPairRegistry.ts`.

## What ships in Phase 2

- BSC `relayEnabled` flipped to `true` so the cross-chain bridge leg
  (USDC.avax → USDC.bsc on open, reverse on close/recovery) goes through
  the existing relay path.
- ABI extended with `ASTER_PORTAL_ABI` (openMarketTrade / closeTrade /
  updateTradeTpAndSl) and a candidate `getPositionsV2` shape — see
  `asterAbi.ts` `POSITION_TUPLE` `TODO_VERIFY_ABI` note.
- `AsterBrokerProvider` tx-building methods filled in. Approve uses
  max-uint256 to avoid future re-approve gas; the open is the next step.
- `AsterPositionsProvider` + `CachedStockPositionsProvider` (60 s TTL)
  ship with a tolerant `mapRawPosition` — drops rows that violate basic
  invariants instead of crashing the close/SL/TP flow. **The `Position`
  struct is unverified**; if Aster ships verified source, simplify
  `mapRawPosition` and remove the per-field tolerance.
- `RelayCrossChainSwapPlanner` adapts `IRelayClient.getQuote` to the
  `ICrossChainSwapPlanner` port (fix #8). The use-case stays vendor-
  agnostic.
- `StockUseCaseImpl` builds open / close / set-exits / return-swap plans.
  Sizing math derives `qty` from the swap planner's `expectedOutRaw`, NOT
  from the user's input USD (fix #6 — bridge fees would otherwise
  silently mis-leverage the open).
- `StockCapability` registers `/stock buy|short|close|sell|sl|tp`. Sub-
  verb is parsed by regex (deterministic — verbs are unambiguous and
  small surface). Cross-chain steps each carry their own `chainId` so
  the FE picks the right network per request.
- Recovery flow is its own mini-app session (NOT chained inside the open
  session) — see plan P2.5 "Recovery flow (CORRECTED design)".
- Six new sign-error codes mirrored in `notifyResolved.ts` lockstep with
  FE `interpretSignError.ts`.
- Loyalty actions: `stock_open_long`, `stock_open_short`, `stock_close`
  seeded via drizzle migration `0027_seed_stock_loyalty_actions.sql`.
- `INTENT_ACTION.STOCK_TRADE` added; capability excluded from the
  `SendCapability` registration loop in `assistant.di.ts`.

## New conventions (Phase 2)

- **Per-step `chainId` on plans.** `StockExecutionStep.chainId` is set
  per step so cross-chain plans can sequence home-chain bridge legs
  alongside venue-chain open legs in one mini-app session. Mirror this
  on any future chain-agnostic capability.
- **`StockExecutionPlan.kind = "recovery"` is its own discriminant** —
  notifyResolved / capability layers branch on this rather than a reused
  `"close"` kind (plan fix #2).
- **`spendTokenAddress` / `spendAmountRaw` only on the LAST home-chain
  leg.** Mirrors `swapCapability`'s last-step convention. Tagging the
  open leg would attribute spend against a delegation row that doesn't
  exist (USDC.bsc isn't a delegated token).
- **`ResolvedSigningRequest` carries `errorCode` + `errorMessage`** on
  the rejected branch. Persisted on the cache record at resolve time so
  capabilities that `waitFor` a step can decide whether to recover.
- **Sign-error codes are lockstep contracts.** Adding one on the FE
  without mirroring in `notifyResolved.ts` (and vice versa) is
  forbidden — the string IS the contract.

## HTTP routes (Phase 2)

- `GET /stocks/pairs` — catalogue. Public, 1 h cache.
- `GET /stocks/quote?symbols=AAPL,TSLA` — mark prices via the cached
  oracle. 10 s private cache. 503 `stocks_unavailable` when soft-disabled.
- `GET /stocks/positions` — authenticated; lists the SCA's open Aster
  positions via `IStockUseCase.listPositions`.

## Recovery success UX

`SigningRequestRecord.planKind = "recovery"` flows through to
`notifyResolved`, which emits a "Funds returned" message + explorer link
on the resolved leg of a recovery flow rather than the generic
"transaction submitted" line. Set in `stockCapability.emitRecoveryMiniApp`
on every queued recovery step.

## Out of scope (Phase 3+)

- Verified `getPositionsV2` ABI struct (`TODO_VERIFY_ABI(positions)`) and
  verified `getMarketInfos` struct against published BscScan source.
- Slippage-aware sizing on the cross-chain leg.
- Stranded-funds recovery beyond the single-retry budget enforced by the
  capability.
