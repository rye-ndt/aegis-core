# One-click Polymarket bet — Backend

Date: 2026-05-20
Status: plan
Supersedes: `be/constructions/2026-05-15-zero-sign-bet-be.md` (kept as historical record). That plan defined the end-state; this plan captures **what is already landed**, what is **still broken today**, and the remaining slices to make `/bet` and `/close` behave identically to `/send` and `/swap` (one tap in chat → mini-app opens → no taps → mini-app closes).
Pair: `fe/privy-auth/constructions/2026-05-20-one-click-bet-fe.md`. Both ship together; the BE flag flip in Slice E is the cutover.

## Why this plan, not just "follow 2026-05-15"

A re-read of the codebase as of 2026-05-20 shows the 2026-05-15 plan is **partially implemented**:

- ✅ `signing_requests` carries `kind` / `purpose` / `domain` / `types` / `primaryType` / `message` / `expectedSigner` / `betId` / `positionId` / `polymarketOrderId` / `signature` (Slice A).
- ✅ `/response` (`signingRequest.usecase.ts:103-200+`) verifies eip712 signature recovery against `expectedSigner`, requires `polymarketOrderId` for `purpose='polymarket_order'`, dispatches by `kind`.
- ✅ `IPredictionMarketBetUseCase` has `advance`, `notifySignResolved`, `setupAdvance`, `notifySetupSignResolved`, `sweepStuckBets`.
- ✅ `predictionMarketBet.usecase.ts` implements `advance`, `enqueueScaToEoa`, `enqueueOrderSign`, `enqueueResidualSweep`, `enqueueSetupGasFunding`, `enqueueSetupApprovals`, `enqueueSetupClobAuth`, `kickPendingBetsForUser` — all gated on `this.useSignQueue`.
- ✅ `PredictionMarketStuckBetSweeperJob` exists, gated on `PREDICTION_MARKETS_USE_SIGN_QUEUE`.
- ✅ DI wiring (`assistant.di.ts:1625`) constructs the use-case with `useSignQueue: true` when the flag + redis + miniAppRequestCache are present.
- ✅ Slot-NX locking via Redis to keep `advance()` idempotent.
- ✅ Tests: `predictionMarketBetAdvance.test.ts`, `signingRequest.eip712.test.ts`.

Today's broken behaviour and remaining gaps:

1. 🔴 **`/bet` confirm card emits `?startapp=place_bet:<intentId>` deep-link** (`placeBetCapability.ts:283,310`). The FE's `deepLink.ts` only matches `close_position` (the `place_bet` verb was deleted in the paper-bet removal on 2026-05-15). So tapping Confirm opens the mini-app and **no handler mounts** — the bet never starts.
2. 🔴 **`/close` confirm card emits `?startapp=close_position:<positionId>`** (`closePositionCapability.ts:155`). That deep-link still routes to `ClosePositionHandler.tsx`, the FE-driven state machine — not the queue.
3. 🟠 **Capability `nextActions` are not gated on the flag.** Even when `useSignQueue=true` the BE still tells the FE to open the FE-driven mini-app handler. So flipping the flag enqueues `sign_request`s but the FE never picks them up.
4. 🟠 **FE has no `SignHandler` dispatcher** — `kind` always defaults to `'userop'`, `eoa_tx` / `eip712` rows are silently mis-signed.
5. 🟡 The FE-callable bet-orchestration routes (`/predictionMarket/setup/:step`, `/bet/:id/transition`, `/bet/:id/finalize`, `/order/place`, …) are still mounted and still used by the legacy FE handler. They survive until cutover; Slice F deletes them.
6. 🟡 No replay coverage for `notifySetupSignResolved` → `kickPendingBetsForUser` (the user-confirmed-bet-during-setup edge).
7. 🟡 `polymarketAdapter` still exposes HMAC paths (`/order POST`, `/auth/api-key`). Once the FE submits orders directly, these become unused; deletion is part of the cleanup slice.
8. 🟡 BLOCKER-3 (`maxUint256` USDC approvals + `setApprovalForAll(true)` on the session-key EOA) survives in `enqueueSetupApprovals`. Explicitly **out of scope** here per product call — tracked separately. Per-bet exact approvals is the follow-up.

## Outcome

```
chat (confirm tap)
  → PlaceBetCapability.confirmBetIntent → BE:
       PredictionMarketBetUseCase.advance(betId)
       → enqueueScaToEoa / setupAdvance kicks first sign_request
  → BE returns nextAction { kind: 'web_app', url: MINI_APP_URL }  // no verb in startapp
mini-app opens
  → SignHandler.fetchNextRequest()
  → dispatchSign on `kind`:
       'userop'  → kernel client UserOp                       (existing)
       'eoa_tx'  → raw EOA tx via viem walletClient           (new)
       'eip712'  → signTypedData                              (new)
                   purpose='clob_auth'      → FE POSTs /auth/api-key, stores creds locally
                   purpose='polymarket_order' → FE POSTs to clob.polymarket.com /order
                                               (FE-held HMAC creds), returns orderId
  → POST /response { txHash | signature, signer, polymarketOrderId? }
  → BE signingRequest.usecase.resolveRequest verifies + fan-outs to:
       notifySetupSignResolved (rows tagged via setupForUserId)
       notifySignResolved      (rows tagged via betId)
  → advance() loops until terminal slot → mini-app sees empty queue → closes
```

No `place_bet:*` deep-link verb. No FE-driven state machine. No per-step REST. No HMAC headers BE-side.

## Scope (in / out)

In scope (BE):

- (Slice D-1) Rewire `PlaceBetCapability.confirmBetIntent` and `ClosePositionCapability.confirmClose` so that when `useSignQueue=true` the returned `nextAction`/keyboard opens the mini-app **without** a `place_bet:` / `close_position:` start_param. Carry only what `SignHandler` needs from start_param (nothing — the queue is keyed by user).
- (Slice D-2) Close-position migration: when `useSignQueue=true`, `initiateClose` calls `advance(closeBetId)` to kick the first enqueue. `enqueueOrderSign` and `enqueueResidualSweep` already handle `betKind='close'` so behaviour is symmetrical — verify.
- (Slice D-3) Capability `previewClose` keeps emitting the chat confirm card (preview is BE-only, no FE work). After confirm, `nextAction` becomes the generic mini-app URL.
- (Slice D-4) Backfill replay tests for the close-bet path through the queue (open + close + residual sweep, drift on close, partial-fill close).
- (Slice D-5) Backfill replay test for the setup → bet kickoff race (user confirms during setup, gas-funding userop lands and bet immediately advances).
- (Slice E-1) Hard-delete FE-callable orchestration routes (`/predictionMarket/setup/:step`, `/bet/:id/transition`, `/bet/:id/finalize`, `/bet/:id/drift-detected`, `/bet/:id/refund`, `/order/place`, `/order/sell`, `/bet/:id/bridge-status`). Keep read-only: `/state`, `/positions`, `/intent/:id`, `/bet/:id`, `/orderbook/:tokenId`.
- (Slice E-2) `IPolymarketAdapter` → `IPolymarketReadAdapter`: drop `placeOrder`, `cancelOrder`, `deriveApiKey`, `sellOrder`. Keep `orderbook`, `orderStatus`, `positions`, `markets`.
- (Slice E-3) Delete `storePolymarketCreds` from `IPredictionMarketBetUseCase` + the `polymarket_creds_enc` column write path. The column itself drops in a follow-up migration once we confirm no row writes survive in prod for 30 days.
- (Slice F-1) Flip `PREDICTION_MARKETS_USE_SIGN_QUEUE` default to `true` across envs (`.env.example`, fly secrets doc).
- (Slice F-2) Remove the `if (!this.useSignQueue) return;` guards from `advance` / `setupAdvance` / `notifySignResolved` / `notifySetupSignResolved` / `sweepStuckBets`. Remove the dual-path code in `confirmBetIntent` and `initiateClose`. Delete `IPredictionMarketBetUseCase.transitionBet` + `finalizeBet` (FE callers) + `recordRefundTxHash` (FE caller) and the matching repo paths if unused.
- Logging + STATUS.md updates per CLAUDE.md.

Out of scope (this plan):

- BLOCKER-1 / 2 / 3 / 4. Acknowledged; tracked in `be/STATUS.md`. BLOCKER-3 (per-bet exact approvals replacing `maxUint256`) is the natural follow-up after F lands.
- Bridging redesign. The bet-launch BE-side bridge (`bridgeUseCase.beginIfMissing`) remains. It emits no `sign_request`. The FE sees the bet status advance from `INITIATED → BRIDGING → BRIDGED` via polling on `/bet/:id` while waiting for the next sign request — but with `useSignQueue=true` the mini-app is sitting in `SignHandler.fetchNextRequest` and doesn't need to know about bridging. The `BRIDGED → SCA_TO_EOA` slot is what flips it back to active.
- Removing `polymarket_creds_enc` column (kept until field deprecation window passes).
- Multi-prediction-market generalisation. Polygon + Polymarket only.
- Restoring a `place_bet:<intentId>` start_param verb. The new contract is **no start_param** — the queue is the source of truth.

## Non-custodial invariants (must hold)

1. BE never reads, writes, transmits, or persists a session-key privkey.
2. BE never reads, writes, transmits, or persists CLOB `apiKey` / `secret` / `passphrase`. Slice E-3 finalises this by removing the storage column from the write path.
3. BE never reads or writes EIP-712 signatures beyond the `signing_requests.signature` field (cache only, dropped on resolution + TTL).
4. BE only consumes **public** Polymarket endpoints. Slice E-2 enforces this at the type level.
5. CI grep gate (existing pattern from BLOCKER-2 acceptance) extends to fail on any new BE reference to `apiKey` / `passphrase` / `clobAuth` outside `signing_requests*` cache code and tests. Wire as part of Slice E-2.

## Design

### 0. Mini-app bootstrap contract — reuse the `?requestId=` URL convention

**This was the missing piece in the prior plan.** The FE's `useRequest` (`fe/.../hooks/useRequest.ts:16`) bootstraps from `window.location.search.get('requestId')` — there is no "fetch next pending for user" entry path. `/send` and `/swap` work because their `sign_calldata` artifact synthesizes a `requestId`, writes it to both caches via `artifactRenderer/telegram.ts:79-137`, and emits `${MINI_APP_URL}?requestId=${id}`. Once the FE has any one requestId, `fetchNextRequest` chains via `/request/:id?after=:id` for subsequent steps — that part already works.

**For the queue-driven bet flow, the existing convention already fits.** `predictionMarketBet.usecase.ts:1369-1370` (the shared enqueue helper) already writes to **both** `signingRequestUseCase.create(baseRecord)` AND `miniAppRequestCache.store(miniAppRequest)` under one requestId — the same pair of writes the `sign_calldata` renderer performs. The only gap is propagating that requestId out to the capability so the chat URL can carry it.

Single change to land this:

1. Make `advance()` and `setupAdvance()` return `{ enqueuedRequestId: string | null }` — the id of the first sign request written this call (null when the slot was already in-flight, the bet was terminal, or the path was bridge-only with no enqueue).
2. The shared enqueue helper already knows the requestId it inserted; bubble it up the call stack (each `enqueue*` returns the id; `advance`'s switch returns whichever fired).
3. `notifySignResolved` / `notifySetupSignResolved` continue to discard the returned id — those paths re-enter for already-open mini-apps, which find the next request via `fetchNextRequest`. Only the **chat-side** confirm path needs the id.

This adds no new artifact kind, no new endpoint, no new FE entry path. The same `?requestId=` URL shape /send and /swap already use.

### 1. Capability `nextActions` rewiring (Slice D-1)

`placeBetCapability.ts:274-290` (`openMiniAppArtifact`) — replace the start_param with the queue contract. The flag check lives in the capability so we can dual-ship.

```ts
function openMiniAppArtifact(
  intentId: string,
  enqueuedRequestId: string | null,
  useSignQueue: boolean,
): Artifact {
  if (!MINI_APP_URL)
    return {
      kind: "chat",
      text: legacyOpenText(intentId),
      parseMode: "Markdown",
    };
  const url =
    useSignQueue && enqueuedRequestId
      ? `${MINI_APP_URL}?requestId=${enqueuedRequestId}` // matches /send + /swap
      : `${MINI_APP_URL}?startapp=place_bet:${intentId}`; // legacy
  return {
    kind: "chat",
    text: "Bet started. Opening the mini app…",
    parseMode: "Markdown",
    keyboard: new InlineKeyboard().webApp("Open mini app", url),
  };
}
```

`confirmBetIntent` already calls `this.advance(bet.id)` under the flag (`predictionMarketBet.usecase.ts:330`). Change is to **capture** the return value and thread it into the artifact:

```ts
// PlaceBetCapability.run, "confirm" branch
await this.betUseCase.confirmBetIntent({
  userId,
  intentId,
  clientOrderId: newUuid(),
});
const { enqueuedRequestId } =
  await this.betUseCase.peekFirstQueuedRequest(userId); // see below
return openMiniAppArtifact(intentId, enqueuedRequestId, useSignQueue);
```

Two options to surface the id; pick whichever matches existing wiring better:

- **(a) Plumb through the return value:** `confirmBetIntent` returns `{ bet, enqueuedRequestId }`. Cleanest — no extra cache lookup. Requires the public `IPredictionMarketBetUseCase.confirmBetIntent` signature to widen (back-compat: legacy callers ignore the new field).
- **(b) Read it back:** add `peekFirstPendingRequestId(userId)` to `ISigningRequestCache` (or expose via the use-case). Capability calls it after `confirmBetIntent` resolves. Avoids signature change; one extra cache read.

Recommend (a) — fewer round-trips, no new cache surface, and `advance()` already knows the id internally.

`executingArtifact` (same file) is the re-tap recovery card. Same treatment, but the requestId may be **stale** (mini-app expired). Solution: call `advance(bet.id)` from the re-tap path before rendering — `advance` is idempotent, the NX lock no-ops if a request is already open for the slot, but if the previous one expired the use-case writes a fresh row and returns its id. Existing convention for stale URLs (same as `/send` re-tap): FE's `useRequest` 404s, App.tsx shows a friendly "request expired" screen, user re-taps and gets the fresh card.

`closePositionCapability.ts` — same pattern. `initiateClose` is already wired (`predictionMarketBet.usecase.ts:618`); widen its return to include `enqueuedRequestId` and thread into the close-card URL.

The flag is read at capability construction time and injected via the existing DI factory (`assistant.di.ts`). Pass `PREDICTION_MARKETS_ENV.useSignQueue` as a constructor arg to `PlaceBetCapability` and `ClosePositionCapability`.

### 2. Confirm paths already kick the driver — verify, don't re-add (Slice D-1, D-2)

`predictionMarketBet.usecase.ts:confirmBetIntent` (line 330) and `initiateClose` (line 618) **both** already call `this.advance(bet.id)` under `useSignQueue`. The only edit on these methods is the §1 return-value widening to surface `enqueuedRequestId`. No new advance call needed.

`advance()` already routes `betKind='close'` rows through `enqueueOrderSign` (which builds a `side=1` SELL order against the recorded `positionId`) and `enqueueResidualSweep` symmetrically. The replay tests in §5 are the verification.

### 3. Drift on close (Slice D-2)

`enqueueOrderSign` already reads `polymarketRead.orderbook(outcomeTokenId)` and compares to `bet.refPriceBps` with `DRIFT_BPS`. For close bets, `refPriceBps` is the bid quoted at confirm time (set by `initiateClose`). On drift exceeded, the use-case writes `bet.status='FAILED' { failureReason: 'drift' }` and, for close bets, must roll back the parent position from `closing` back to `open`. The repo already exposes `updatePositionStatus(id, status, patch?)` (`IPredictionMarketBetRepository.ts:266`, impl `predictionMarketBet.repo.ts:398`) — use that, no new method needed.

Add this branch to `enqueueOrderSign` when `bet.betKind === 'close'`:

```ts
if (driftExceeded) {
  await this.repo.update(bet.id, { status: "FAILED", failureReason: "drift" });
  if (bet.betKind === "close" && bet.positionId) {
    await this.repo.updatePositionStatus(bet.positionId, "open");
  }
  // Drift notification: existing convention is the FE's `pmApi.driftDetected`
  // returning a `reconfirm` decision and PlaceBetHandler showing a "price
  // changed" full-screen. With the queue-driven flow the FE never gets that
  // far — there's no enqueued sign request to dispatch. So the BE must push
  // a chat message via the existing receipt broadcaster.
  // Reuse `PredictionMarketReceiptBroadcaster` (already used for
  // `bet_placed` / `bet_failed` / `position_closed` cards). Add a new card
  // verb `bet_drift` rendered by `resultCard.render.ts`. No new transport.
  await this.receiptBroadcaster.emitDriftCard(bet);
  return;
}
```

The receipt broadcaster is already in DI and already posts to the user's chat — same convention `bet_failed` uses.

### 4. `kickPendingBetsForUser` race (Slice D-5)

Today: user confirms a bet while setup is mid-flight (e.g. gas funding just landed but approvals are still queued). `confirmBetIntent` calls `setupAdvance` (because `setup.setupStep !== 'complete'`). When setup completes, `notifySetupSignResolved`'s `authed→complete` branch calls `kickPendingBetsForUser(userId)` which then calls `advance(bet.id)` for any active bet.

Risk: the active-bet lookup uses `findActiveBetForUser` (find non-terminal bet for user). If the user has a `close` bet AND an `open` bet active concurrently this returns one row arbitrarily. Either:

- (a) extend to `findActiveBetsForUser` (plural) and advance each; or
- (b) tighten the invariant: the bet repo already rejects creating a new bet while another is non-terminal (`BetInFlight`). Confirm in the test below.

Pick (b) and add a unit test asserting `repo.createBet` 409s during in-flight, including across `betKind='open'` and `betKind='close'`.

### 5. Replay tests (Slice D-4, D-5)

Extend `predictionMarketBetAdvance.test.ts` with cases:

- `close-happy`: setup complete, position FILLED → user calls `initiateClose` → `advance` enqueues an `eip712 polymarket_order` with `side=1` → `notifySignResolved` with `polymarketOrderId` → `ORDER_SUBMITTED` → poller flips bet to `FILLED` and position to `closed` with PnL.
- `close-drift`: live orderbook drifts beyond `DRIFT_BPS` between confirm and enqueue → bet `FAILED { drift }`, position back to `open`, chat drift message dispatched.
- `close-partial`: poller reports partial fill → residual sweep enqueued (`eoa_tx` USDC transfer EOA→SCA) → bet finalised, position state `closed-partial` (or whatever the existing semantic is).
- `setup-bet-race`: user confirms bet during `gas_funded` → `setupAdvance` enqueues approvals, bet sits in `INITIATED` → all three approvals resolve → `clob_auth` resolves → `setup=authed→complete` → `kickPendingBetsForUser` → bet advances to `SCA_TO_EOA`.

The test harness should drive `notifySignResolved` / `notifySetupSignResolved` with synthetic `/response` payloads; no actual signing required. Assert per-step: `signingRequest.create` was called with the expected `kind`/`purpose`/`message` shape; the bet/setup row landed in the expected state.

### 6. Route deletion (Slice E-1)

Verified route inventory in `be/src/adapters/implementations/input/http/httpServer.ts:236-244` (exactRoutes) + `:312-316` (paramRoutes). Routes to delete:

| Verb | Route                                      | Handler                                                      | Use-case method                                         |
| ---- | ------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------- |
| POST | `/predictionMarket/setup/init`             | `handlePmSetupInit`                                          | `recordSetupStep('sca_deployed')` path                  |
| POST | `/predictionMarket/setup/creds`            | `handlePmSetupCreds`                                         | `storePolymarketCreds`                                  |
| POST | `/predictionMarket/order/place`            | `handlePmPlaceOrder`                                         | adapter `placeOrder`                                    |
| POST | `/predictionMarket/order/sell`             | `handlePmPlaceOrder` _(shared with /place; deletes with it)_ | adapter `placeOrder` (side=SELL)                        |
| POST | `/predictionMarket/bet/:id/transition`     | `handlePmTransitionBet`                                      | `transitionBet`                                         |
| POST | `/predictionMarket/bet/:id/finalize`       | `handlePmFinalizeBet`                                        | `finalizeBet` _(kept callable from poller — see below)_ |
| GET  | `/predictionMarket/bet/:id/bridge-status`  | `handlePmBridgeStatus`                                       | bridge use-case                                         |
| POST | `/predictionMarket/bet/:id/drift-detected` | `handlePmDriftDetected`                                      | `reportPriceDrift`                                      |
| POST | `/predictionMarket/bet/:id/refund`         | `handlePmRecordRefund`                                       | `recordRefundTxHash`                                    |

`finalizeBet` stays on the use-case (still called by `PolymarketPositionPollerJob` and `notifySignResolved`'s residual-sweep success). Just unbind the HTTP route.

`reportPriceDrift` / `transitionBet` / `recordRefundTxHash` / `recordSetupStep` / `storePolymarketCreds`: delete both route and method in Slice F. Until then, mark them with a `@deprecated` TSDoc and add a runtime warning log when called, so any straggler in dev catches the migration is incomplete.

Kept routes (verified present):

- `GET /predictionMarket/state` (`:238`) — mini-app rehydration + chat-side previews.
- `GET /predictionMarket/positions` (`:244`) — `/positions` chat.
- `GET /predictionMarket/intent/active` (`:239`) — active intent lookup.

**Routes the prior plan claimed were "kept" but don't actually exist** — reconcile before Slice E-1 ships:

- `GET /predictionMarket/intent/:id` — not registered. The FE's `pmApi.intent(ctx, intentId)` in the legacy `PlaceBetHandler` was hitting the active variant or a route I missed; re-grep before deleting handlers.
- `GET /predictionMarket/bet/:id` — not in exactRoutes nor paramRoutes by name; if a debug consumer exists, add it (cheap) or drop the read-API surface.
- `GET /predictionMarket/orderbook/:tokenId` — not registered. The legacy FE called `pmApi.orderbook(ctx, tokenId)`; that endpoint may be `/predictionMarket/order/…` or absent. Confirm by grep; if absent, the chat-side preview path also doesn't use HTTP and the route stays absent.

Action: before E-1 lands, regrep the actual paramRoutes registrations and the surviving FE chat-side callers. If a debug/read route is needed, add it as a thin wrapper over the use-case read methods (`getBet`, `getBetIntent`, polymarketRead.orderbook). Do not invent new endpoints — keep the surface minimal.

### 7. Adapter trim (Slice E-2)

```ts
// be/src/use-cases/interface/predictionMarket/IPolymarketAdapter.ts
// Becomes IPolymarketReadAdapter:
interface IPolymarketReadAdapter {
  orderbook(
    tokenId: string,
  ): Promise<{ bidBps: number; askBps: number; midBps: number }>;
  orderStatus(orderId: string): Promise<{
    status: "live" | "matched" | "filled" | "cancelled" | "expired";
    filledShares?: string;
    avgPriceBps?: number;
  }>;
  positions(maker: `0x${string}`): Promise<PolymarketPosition[]>;
  markets(slug?: string): Promise<MarketSummary[]>;
}
```

Drop from the adapter implementation: `placeOrder`, `cancelOrder`, `sellOrder`, `deriveApiKey`, any HMAC signing helper, the env var `POLYMARKET_API_BASE` (replaced by `POLYMARKET_PUBLIC_BASE` — verify they're the same value today; if so, just rename for clarity).

DI: `assistant.di.ts` swaps the adapter binding to the read-only one.

`polymarketPositionPollerJob` already uses `orderbook` / `orderStatus` / `positions` — no change needed there.

Create `be/src/adapters/implementations/output/predictionMarket/status.md` (if absent) documenting the **read-only invariant**: this adapter must never POST, never carry HMAC headers, never see user secrets.

### 8. Flag flip + cleanup (Slice F)

1. `predictionMarketEnv.ts:95` → flip default to `true`. Update `.env.example` to remove the flag entirely.
2. Walk every `if (!this.useSignQueue) return;` / `if (this.useSignQueue) {` site and inline the queue branch:
   - `predictionMarketBet.usecase.ts:327, 612, 761, 820, 902, 924, 973` (per grep)
   - `assistant.di.ts:578, 1625, 1632, 1653`
   - `predictionMarketStuckBetSweeperJob.ts:33-34`
3. Delete the now-dead helpers (`recordSetupStep`, `transitionBet`, `recordRefundTxHash`, `storePolymarketCreds`, `finalizeBet` if no internal caller, FE-driven `bridgeStatus` HTTP). Also delete the `IPolymarketAdapter` surface methods removed in E-2.
4. Delete `IPredictionMarketBetUseCase` members that have no remaining callers. Update mock implementations in tests.
5. CI grep gate (from §non-custodial-invariants) wired.

### 9. Logging additions

Per CLAUDE.md mandatory logging. Existing logs are good; add:

- `advance()` enqueue/no-op decisions: already `step: 'advance-skipped-deps-missing' | 'advance-bet-not-found' | 'advance-setup-incomplete'`. Add explicit `step: 'advance-enqueued-{slot}'` after a successful enqueue so the sweeper diagnostics are unambiguous.
- `notifySignResolved`: log `{ step: 'sign-resolved', betId, kind, purpose, slot, rejected }`.
- `kickPendingBetsForUser`: log `{ step: 'kick-after-setup', userId, betId, kicked: !!bet }`.
- Close path: `{ step: 'close-drift', betId, positionId, drift }` when drift triggers on a close bet.
- Sweeper: existing `sweeper-advance-failed`. Add `{ step: 'sweep-summary', attempted, advancedOk, errors }` per tick at info level.

New metadata names introduced (record in STATUS.md after Slice F):

- `slot` — the (bet, status) NX lock key string (`sca_to_eoa | order_sign | residual_sweep | setup_gas_funding | setup_approve_{0..2} | setup_clob_auth`).
- `polymarketOrderId` — already on the wire from /response.
- `betKind` — `'open' | 'close'`.

### 10. Backwards compatibility window

Flag-gated rollout means BE can advance through D in production with the flag still off (no user-visible change, replay tests cover the new paths). Slice E (route deletion) is the irreversible step. Order:

1. D ships → flag still off → no behaviour change → land in prod, verify via dark sweeps + the existing replay test suite (run with flag on in CI only).
2. FE plan slices 0–2 ship → mini-app dispatcher supports all three kinds → still no user-visible change because BE keeps using the legacy flow.
3. F-1 (flag flip) lands together with FE plan slice 3 (handler deletion + deep-link verb removal). This is the single user-visible cutover. Roll back = flip the flag back; the legacy code still exists.
4. E + F-2 land 1–2 weeks later, after the flag has been stable. Routes and the dual-path code disappear together.

## Tasks (shippable slices)

Slice D — capability rewiring + replay coverage. Flag stays off; deployable on its own.

1. Inject `PREDICTION_MARKETS_ENV.useSignQueue` into `PlaceBetCapability` and `ClosePositionCapability` constructors.
2. **Surface `enqueuedRequestId` from `advance` / `setupAdvance`.** Each `enqueue*` helper already knows the id it inserts via `signingRequestUseCase.create` — bubble it up. `advance` / `setupAdvance` return `{ enqueuedRequestId: string | null }`. `notify*` discards it; chat-side capability propagates it.
3. Widen `confirmBetIntent` / `initiateClose` return types with `enqueuedRequestId`. Update `openMiniAppArtifact` / close-card builder to emit `?requestId=${id}` when both the flag is on AND `enqueuedRequestId !== null`; otherwise fall back to the legacy `?startapp=` URL.
4. `enqueueOrderSign` drift branch: write `bet.status='FAILED'`; for `betKind='close'`, `repo.updatePositionStatus(positionId, 'open')`; broadcast `bet_drift` card via existing `PredictionMarketReceiptBroadcaster`. (Add the `bet_drift` verb to `resultCard.render.ts` — reuse the existing card pipeline; do not invent a new transport.)
5. Replay test additions (D-4, D-5):
   - `predictionMarketBetAdvance.test.ts`: close-happy, close-drift, close-partial, setup-bet-race, `advance` returns the correct enqueuedRequestId per slot.
   - Assert `repo.createBet` rejects concurrent in-flight bets across both `betKind` values.
6. Logging additions per §9.

Slice E — adapter trim + route deletion. Requires Slice D + FE Slice 3 deployed.

7. `IPolymarketReadAdapter` introduction; `polymarketAdapter.ts` becomes read-only. Delete HMAC code paths. New `status.md`.
8. Delete the eight FE-callable routes from `httpServer.ts`. Confirm no production caller via 7-day prod log grep.
9. CI grep gate against `apiKey|passphrase|clobAuth` outside cache code.

Slice F — flag flip + dual-path removal. Cutover.

10. Flip default. Inline every `useSignQueue` guard.
11. Delete `recordSetupStep`, `transitionBet`, `recordRefundTxHash`, `storePolymarketCreds` (use-case + repo paths). Verify with tsc + tests.
12. Delete the `polymarket_creds_enc` write path; column drop is a follow-up migration after 30-day deprecation window.
13. `be/STATUS.md`: top-of-file entry "Prediction markets — one-click cutover — 2026-MM-DD". Cross-link the FE plan.

Each slice is independently revertable. D is safe on its own. E is safe once D + FE 3 are in prod. F is the cutover.

## Convention adherence (no new mechanisms)

Cross-check before merging — every item below must reuse an existing pattern, not introduce a new one.

| Concern                                  | Existing convention reused                                                                                                                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mini-app bootstrap from chat             | `${MINI_APP_URL}?requestId=${id}` — same shape `sendCapability` / `swapCapability` use via the `sign_calldata` artifact renderer (`artifactRenderer/telegram.ts:79-137`).                                                                                  |
| Multi-step sign chaining inside mini-app | `fetchNextRequest` polling `/request/:id?after=:id` — already proven on the approve→send path.                                                                                                                                                             |
| Sign request persistence                 | `signingRequestUseCase.create` + `miniAppRequestCache.store` paired write, already performed by the shared enqueue helper (`predictionMarketBet.usecase.ts:1369-1370`).                                                                                    |
| `/response` dispatch                     | Existing `signingRequest.usecase.ts:resolveRequest` switch on `record.kind`. New paths (`eoa_tx`, `eip712`) already landed in Slice A.                                                                                                                     |
| Per-slot idempotency                     | Existing Redis NX lock pattern (`(betId, slot)` key). Not new.                                                                                                                                                                                             |
| Stale-URL on stuck-bet re-advance        | FE `useRequest` already 404s on expired ids; App.tsx renders the existing "request not found" screen. User re-taps chat → capability calls `advance` (idempotent) → new requestId in fresh card. **No new "request expired" UI** — same as `/send` re-tap. |
| Drift notification to user               | Existing `PredictionMarketReceiptBroadcaster` (used by `bet_placed` / `bet_failed` / `position_closed`). New card verb `bet_drift`; no new transport.                                                                                                      |
| Position state rollback                  | Existing `updatePositionStatus(id, status, patch?)` (`IPredictionMarketBetRepository.ts:266`). Do not add `setPositionStatus`.                                                                                                                             |
| Logging                                  | Existing pino conventions with `step`/`requestId`/`betId`/`durationMs`. No new logger module.                                                                                                                                                              |
| Feature flag                             | Existing `PREDICTION_MARKETS_ENV.useSignQueue` already wired through DI. Slice F simply flips the default.                                                                                                                                                 |

If a section of the implementation drifts from this table during code review, push back — the alternative is almost certainly an unnecessary new abstraction.

## Risks + mitigations

- **`advance()` race when two `/response`s arrive simultaneously.** Mitigation: per-`(betId, slot)` Redis NX lock already in place. Verify the lock TTL exceeds `signingRequest.usecase.RECENT_TXHASH_TTL_MS` so a slow retry can't double-enqueue.
- **Setup-bet race during the flag-off → flag-on transition.** A bet created under the legacy flow could land mid-setup when the flag flips. Mitigation: stuck-bet sweeper picks it up within `STUCK_BET_TIMEOUT_MS`; the legacy FE handler closes once it sees `bet.status` advance via polling. Document this in the cutover runbook — recommend draining in-flight bets to <5 before flipping.
- **Position closed twice if `enqueueOrderSign` drift fires after `notifySignResolved` already started flipping state.** Mitigation: drift branch runs **before** any `signing_request` insert. The NX lock ensures only one branch wins per slot.
- **`finalizeBet` route deletion breaks the poller.** The poller calls the use-case method directly (in-process), not via HTTP. Verify by grep before deleting the route.
- **Bridge step's bet status (`BRIDGING`) is invisible to the queue-driven mini-app.** Mitigation: while bridging, no `sign_request` is enqueued; the mini-app's `fetchNextRequest` returns empty; FE shows a generic "Working on it…" idle spinner. The bridge poller flips the bet to `BRIDGED` and calls `advance`, which enqueues the next slot — mini-app's fetch picks it up on the next poll. Document that bridge wait may take 30s on first bet; UX is fine.
- **A malicious FE could lie about `polymarketOrderId`.** Mitigation: the BE's `polymarketPositionPollerJob` queries `clob.polymarket.com/data/order/:id` (public). A bogus id ages out → bet fails → sweep refunds. Worst case: one wasted bet attempt; no funds at risk because the underlying signed order is what would move USDC, and that signature went straight from FE to Polymarket.
- **CLOB creds in CloudStorage are encrypted with `privyDid`.** Acknowledged. Tracked under BLOCKER-2. Once BLOCKER-2 lands the same fix transparently covers CLOB creds.
- **Standing `maxUint256` approvals on the EOA persist after this plan.** Tracked as BLOCKER-3. Follow-up plan converts `enqueueSetupApprovals` to per-bet `approve(stake) → place → approve(0)` flanking. Until then, the EOA's blast radius == the user's full Polygon USDC balance.

## Acceptance

- `/bet $5 yes` on a freshly-set-up user → chat confirm tap → mini-app opens → no taps inside → closes within **≤30s on first bet, ≤10s on subsequent**. Verified on iOS, Android, Telegram Desktop.
- `/positions` shows the new bet within 60s of fill.
- `/close` confirm tap on an open position → mini-app opens → no taps → closes ≤10s. Position transitions `open → closing → closed` with realised PnL.
- Force-close mini-app mid-flow, reopen 5 minutes later → flow resumes from BE canonical state via stuck-bet sweeper. No double-charge, no double-bet, no orphaned approval.
- Drift > `DRIFT_BPS` between confirm and `enqueueOrderSign` → bet `FAILED { failureReason: 'drift' }`, position rolled back to `open` (close case), chat posts drift message, no order sent to Polymarket.
- Partial fill or unfilled → residual sweep auto-runs in the same mini-app session if user is still open, otherwise the sweeper handles it on next open / next tick.
- BE log of a full happy-path **first** bet contains: 0 CLOB credential references, 0 signature contents, 1 `polymarketOrderId`, 2 UserOp hashes (setup gas funding + SCA→EOA stake transfer), 3 EOA tx hashes (the three approvals), and 0–1 EOA tx hashes for residual sweep (only when partial/unfilled). Subsequent bets: 1 `polymarketOrderId`, 1 UserOp (SCA→EOA), 0–1 EOA tx hashes (sweep). Cross-check the counts against `enqueueSetupGasFunding` / `enqueueSetupApprovals` / `enqueueScaToEoa` / `enqueueOrderSign` / `enqueueResidualSweep` impls before merging — if any helper grows a slot, update the count.
- Replay test suite green: happy bet, partial + sweep, unfilled + sweep, drift fail, BetInFlight on parallel attempt, idempotent `advance()` on duplicate `/response`, setup-bet race, close-happy, close-drift, close-partial.
- `grep -rE "(clobAuth|apiKey|passphrase|deriveApiKey|placeOrder|sellOrder)" be/src/adapters/implementations/output/predictionMarket/` returns no production-code matches after Slice E.
- `grep -nE "useSignQueue" be/src/` returns no matches after Slice F.

## STATUS.md updates after each slice

- Slice D: append to the existing 2026-05-15 entry — "D landed; close + setup-race covered by replay tests."
- Slice E: append — "E landed; routes deleted, adapter read-only."
- Slice F: top-of-file entry "Prediction markets — one-click cutover — 2026-MM-DD". List deleted use-case methods, deleted routes, the new `slot` metadata field, the read-only adapter invariant, and the BLOCKER-3 follow-up.

Also create / update:

- `be/src/use-cases/interface/predictionMarket/status.md` — `advance()` idempotency invariant, per-`(betId, slot)` NX lock contract.
- `be/src/adapters/implementations/output/predictionMarket/status.md` — read-only adapter invariant.
- `be/src/adapters/implementations/output/capabilities/status.md` — `PlaceBetCapability` + `ClosePositionCapability` now emit a generic mini-app open URL with no start_param; deep-link verbs are dead.
