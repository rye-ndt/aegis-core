# Stage 4 — One-Click Bet Execution (BE construction doc)

Date: 2026-05-07
Stages 1–2 (universe + clustering): shipped. Stage 3 (detect + verify + broadcast): shipped. This doc covers stage 4 — placing the actual bet, BE side only. The FE side (mini-app handlers, in-app state machines, result-card rendering, position list view) is documented in `fe/privy-auth/constructions/2026-05-07-prediction-markets-stage4.md`.

## Goal

User taps **Side A** or **Side B** on a finding card → bot asks for stake amount → user types amount → bot shows a confirm card → user taps **Confirm** → mini-app opens silently, executes the bet, and the BE renders a receipt back to the chat. Zero Privy/wallet prompts after first-bet setup.

## Decided architecture (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Funds custody on Polygon | **SCA on Polygon** (matches user mental model + paymaster sponsorship of any side txs) |
| 2 | Polymarket maker | **EOA-maker** (session key acts as the EOA, ECDSA signature path — documented Polymarket integration). SCA→EOA transfer of exact stake per bet. |
| 3 | Multi-step UX | **Amount prompt + confirm card** (mirrors `/send` convention) |
| 4 | Bridge sizing | **JIT exact stake per bet** (Relay solver covers destination gas) |
| 5 | Polygon onboarding | **SCA + delegated session key on Polygon**, identical mechanism to Avalanche onboarding (extends existing session-delegation system) |

## End-to-end fund flow

```
Avalanche                                  Polygon
─────────                                  ───────
User SCA (USDC.e holder)                   User SCA (Polygon, paymaster-sponsored)
  │                                          │
  │ Relay quote: SCA(Avax) → SCA(Pol)        │
  │ EXACT_OUTPUT USDC, solver pays POL gas   ▼
  └──────────────────────────────────────▶  Receives stake USDC
                                             │
                                             │ UserOp: transfer stake USDC SCA→EOA
                                             │ (gas-sponsored)
                                             ▼
                                           Session-key EOA (Polygon)
                                             │
                                             │ Sign EIP-712 Polymarket order
                                             │ POST /order → CLOB
                                             ▼
                                           Filled position; outcome tokens
                                           credited to EOA
```

The session-key EOA on Polygon **only ever holds outcome tokens and dust USDC during a bet**. Steady-state custody lives in the SCA. EOA approvals to Polymarket contracts are one-time at setup.

## 1. BE pieces

| # | Piece | Path | Lifecycle |
|---|---|---|---|
| 1 | Polygon entry in chain registry | `be/src/helpers/chainConfig.ts` (already has `chainId: 137, relayEnabled: true` per Explore — verify SCA factory + paymaster keys are wired) | one-time |
| 2 | Polygon SCA + delegated session key wired into existing onboarding | extend `session-delegation` system to cover Polygon | one-time per user |
| 3 | Polymarket adapter (sign-helpers, place, cancel, get position, orderbook, L1/L2 auth) | `be/src/adapters/implementations/output/polymarket/` (new) | per bet |
| 4 | Polymarket creds storage (AES-encrypted L2 HMAC creds) | `predictionMarketUserSetup.polymarketCredsEnc` | one-time per user |
| 5 | Relay client extension: `EXACT_OUTPUT` + intent-status polling | extend `be/src/adapters/implementations/output/relay/relayClient.ts` | infra |
| 6 | Place-bet capability + bet-intent chat flow + state machine | `be/src/domain/capabilities/placeBet/` (new) | per bet |
| 7 | Close-position capability | `be/src/domain/capabilities/closePosition/` (new) | per close |
| 8 | Drizzle tables: `predictionMarketUserSetup`, `predictionMarketBetIntents`, `predictionMarketBets`, `predictionMarketPositions` | schema + repos | one-time |
| 9 | Position poller job | `be/src/jobs/polymarketPositionPoller.ts` (new) | recurring 5 min |
| 10 | Bet-amount intent (chat-side amount prompt + confirm card; renders BE-side via existing result-card framework) | new intent in intent parser; result-card templates | per bet |
| 11 | HTTP endpoints consumed by the mini-app | `be/src/adapters/implementations/input/http/predictionMarket.ts` (extend) | infra |

## 2. Conversational flow (chat-side, owned by BE)

State per bet stored in `predictionMarketBetIntents` (separate from execution `bets` table — represents the chat-side intent, not the on-chain attempt).

**Step 1 — Tap Side A on finding card.** Callback `place_bet:findingId:side`. BE writes intent row `status='awaiting_amount'`, replies in chat:

> *"How much USDC do you want to bet on **\<short side label\>**? Reply with an amount (min $1, max $\<configurable cap\>)."*

**Step 2 — User replies with amount.** Intent parser detects "amount-reply" mode for the active intent (mirror of the send-token amount prompt). Validates against min/max + user's Avalanche USDC balance. Updates intent `status='awaiting_confirm'`, replies with **confirm card**:

> **Confirm bet — \<side label\>**
> Stake: $10 USDC (from Avalanche)
> Bridge: ~$0.02 fee, ~30s
> Reference price: $0.42 → ~23.8 shares
> Max payout if win: $23.80
>
> [Confirm] [Cancel]

**Step 3 — User taps Confirm.** Callback `confirm_bet:intentId`. BE marks intent `status='executing'`, writes initial `predictionMarketBets` row, and emits a deep-link result-action that opens the mini-app with `intentId`.

**Step 4 — Mini-app executes** (state machine in §3). FE POSTs progress to BE endpoints; BE renders progress messages back to chat:
   - *"Bridging $10 USDC to Polygon..."* (replaceable)
   - *"Placing order..."* (replaceable)
   - Final receipt card on completion (or failure card with reason).

**Step 5 — Receipt card.** §6.

## 3. Execution state machine (BE-tracked, FE-driven)

`predictionMarketBets.status`:

```
INITIATED
  → BRIDGING (Avax USDC → Polygon SCA)
  → BRIDGED
  → SCA_TO_EOA (transfer stake to EOA via UserOp)
  → ORDER_SIGNED
  → ORDER_SUBMITTED
  → {FILLED | PARTIAL | UNFILLED | FAILED}
```

All transitions persisted server-side. Mini-app close mid-flow → reopen resumes from current state. `clientOrderId` (uuid) is the idempotency key for Polymarket POST.

### BE responsibilities per state

| State | BE owns |
|---|---|
| `INITIATED` | Row written when user taps Confirm. Emits deep link. |
| `BRIDGING` | FE submits Relay intent on Avax SCA; BE records `bridgeIntentId`. BE polls Relay's intent-status endpoint and exposes a unified status to FE via `/predictionMarket/bet/:id/bridge-status`. Cap at `bridgeTimeoutMs` (default 90s). |
| `BRIDGED` | FE confirms balance; BE transitions on receipt of FE's POST. |
| `SCA_TO_EOA` | FE submits UserOp; BE records `scaToEoaTxHash` on completion. |
| `ORDER_SIGNED` | BE serves live orderbook top-of-book via `/predictionMarket/orderbook/:tokenId`. If FE reports drift > `maxOrderDriftBps`, BE re-renders chat re-confirm card and pauses execution. |
| `ORDER_SUBMITTED` | FE POSTs signed EIP-712 order; BE attaches L2 HMAC creds (decrypted from `polymarketCredsEnc`) and forwards to Polymarket CLOB. Stores `polymarketOrderId`. |
| `FILLED \| PARTIAL \| UNFILLED` | BE polls `/data/orders/{id}` directly (independent of FE — handles the case where the user closed the app). On terminal state, BE writes `predictionMarketPositions` row, refunds leftover EOA USDC to SCA via paymaster-sponsored UserOp (if any), renders receipt card. |

**Why BE wraps Polymarket calls instead of FE going direct:** the L2 HMAC creds are stored encrypted on the BE — they never ship to the client. FE provides only the signed order (the secret-bearing piece is the EIP-712 signature). BE attaches HMAC headers and forwards.

## 4. First-bet setup (one-time)

State on `predictionMarketUserSetup`. The BE owns the state machine; FE drives execution (see FE doc §2).

```
pending
  → sca_deployed       (Polygon SCA + delegated session key)
  → gas_funded         (~0.05 MATIC dust delivered to EOA, for one-time approvals)
  → approved           (3 approvals from EOA)
  → authed             (Polymarket L1 → L2 creds derived and stored encrypted)
  → complete
```

BE responsibilities:

- Expose endpoints for each state transition (`POST /predictionMarket/setup/:step` with the relevant artifacts).
- Encrypt and store `{apiKey, secret, passphrase}` returned from the Polymarket `/auth/api-key` call (FE forwards them once after deriving them in-app).
- Persist `polygonScaAddress`, `polygonEoaAddress`, `bootstrapBridgeIntentId`, `approvalsTxHashes`.
- Idempotency: each step writes its outcome before advancing. Re-POSTs with the same artifact are no-ops.

## 5. Closing positions

The agent must support closing via NL intent or **Close** button on the position card. We persist everything needed:

```ts
predictionMarketPositions {
  id, userId, marketId, outcomeTokenId, side,
  sizeShares, entryPriceAvgBps, entryStakeUsdc,
  openingBetId,                  // FK to bets
  closingBetId,                  // FK once close starts
  status: 'open'|'closing'|'closed'|'resolved',
  resolvedOutcome, currentValueUsdc,
  realizedPnlUsdc, openedAt, closedAt
}
```

**Close flow** (`closePositionCapability`):

1. User invokes close (callback or NL) → BE replies confirm card with current quote and PnL preview: *"Sell 23.8 shares at ~$0.51 = $12.14 (entry $10, +21.4%). Confirm?"*
2. On Confirm → BE writes a new `predictionMarketBets` row with `betKind='close'`, `parentBetId=<opening bet id>`, status `INITIATED`. Deep-links into mini-app with the new bet id.
3. Mini-app builds and signs a sell limit order on the same `outcomeTokenId`. POSTs to BE `/predictionMarket/order/sell`. BE forwards to Polymarket.
4. On fill → BE submits paymaster-sponsored UserOp to transfer USDC from EOA back to Polygon SCA. Updates position `status='closed'`, writes `realizedPnlUsdc`.
5. BE renders `position_closed` receipt card with realized PnL.

We **do not** model close as "buy the other side." Selling the outcome token is the single canonical close path.

**Reconciliation:** the position poller (§9) cross-checks our `predictionMarketPositions` rows against Polymarket's `/data/positions` every 5 min. On disagreement, Polymarket's view wins and we update locally. This protects against state drift (manual closes via Polymarket web, partial fills missed by submit-time poller, edge cases in market resolution).

## 6. Receipt + position cards (BE field spec)

The BE emits `IntentResult` objects of these new card kinds. FE renders them — see FE doc §6 for renderer wiring. Field specs:

**`bet_placed`** — post-fill receipt
- side label (from finding)
- stake (input)
- reference price + fill price (Polymarket fill)
- shares acquired (Polymarket fill)
- max payout if win (shares × $1.00)
- bridge tx (Relay intent id, link to Relay explorer)
- SCA→EOA tx (Polygon explorer link)
- order id (Polymarket order link)
- actions: `[View position]` (callback `view_position:positionId`), `[Open in Polymarket]` (url)

**`bet_failed`** — terminal failure
- failure reason (human-readable, mapped from `failureReason` enum)
- last successful state
- actions: `[Retry]` (callback `retry_bet:intentId`), `[Cancel]` (callback)

**`position_open`** — active position view
- market question (Polymarket gamma)
- side, size (shares), entry price (local + reconciled)
- current price (gamma top-of-book)
- unrealized PnL = (current − entry) × size
- actions: `[Close]` (callback `close_position:positionId`), `[Open in Polymarket]` (url)

**`position_closed`** — post-close receipt
- entry price, exit price, realized PnL
- actions: `[Open in Polymarket]` (url)

**`position_resolved`** — settlement notification (pushed by poller when Polymarket marks the market resolved)
- outcome (YES/NO won)
- payout received (or zero)
- actions: `[Open in Polymarket]` (url)

## 7. Logging convention (mandatory per CLAUDE.md)

Pino, structured-first, kebab-case messages. Scope per module. Step events at every state transition.

```ts
const log = createLogger("placeBetCapability");

log.info({ userId, findingId, side, intentId, step: "started" }, "place-bet");
log.info({ userId, intentId, step: "amount-received", stakeUsdc }, "place-bet");
log.info({ userId, intentId, step: "confirmed" }, "place-bet");
log.info({ userId, betId, step: "bridge-submitted", bridgeIntentId }, "place-bet");
log.info({ userId, betId, step: "bridged", durationMs }, "place-bet");
log.info({ userId, betId, step: "sca-to-eoa", txHash }, "place-bet");
log.info({ userId, betId, step: "order-signed", clientOrderId, refPriceBps }, "place-bet");
log.info({ userId, betId, step: "submitted", polymarketOrderId }, "place-bet");
log.info({ userId, betId, step: "filled", filledShares, filledAvgPriceBps, durationMs }, "place-bet");
log.warn({ userId, betId, step: "partial-fill", filledShares, requestedShares }, "place-bet");
log.warn({ userId, betId, step: "unfilled", reason }, "place-bet");
log.error({ userId, betId, err, step: "failed", failureReason }, "place-bet");
```

`closePositionCapability` mirrors the same step taxonomy with `kind:'close'`.

`polymarketAdapter`: `debug` per request/response (without secrets), `warn` on 4xx, `error` on 5xx + retries-exhausted. Cache hit/miss at `debug` with `choice: 'hit' | 'miss'`.

`polymarketPositionPoller`: `tick-start` / `tick-end` with `userCount`, `positionsReconciled`, `divergencesFixed`, `durationMs`.

**Privacy:** never log `polymarketCredsEnc`, `secret`, `passphrase`, raw signatures, session-key material, `privyToken`, `serializedBlob`.

## 8. Schema

```ts
// 1. Per-user setup state
predictionMarketUserSetup {
  userId: text PK ref users.id,
  polygonScaAddress: text not null,
  polygonEoaAddress: text not null,
  bootstrapBridgeIntentId: text,        // Relay intent id for MATIC dust
  approvalsTxHashes: text[],            // 3 hashes
  polymarketCredsEnc: text,             // AES-encrypted {apiKey, secret, passphrase}
  setupStep: text not null,             // 'pending'|'sca_deployed'|'gas_funded'|'approved'|'authed'|'complete'
  createdAt, updatedAt
}

// 2. Chat-side bet intent (the multi-step UX)
predictionMarketBetIntents {
  id: text PK,
  userId: text not null,
  findingId: text ref findings.id,
  side: text not null,                  // 'A'|'B' or token id mapping
  outcomeTokenId: text,
  stakeUsdc: numeric,                   // null until amount step
  refPriceBps: integer,
  status: text not null,                // 'awaiting_amount'|'awaiting_confirm'|'executing'|'completed'|'cancelled'|'failed'
  betId: text,                          // FK once execution starts
  expiresAt: timestamp,                 // GC stale intents (e.g. 1h)
  createdAt, updatedAt
}

// 3. Execution row
predictionMarketBets {
  id: text PK,
  userId: text not null,
  intentId: text ref intents.id,
  findingId: text ref findings.id,
  marketId: text not null,
  outcomeTokenId: text not null,
  side: text not null,
  stakeUsdc: numeric not null,
  refPriceBps: integer not null,
  clientOrderId: text not null unique,
  bridgeIntentId: text,
  scaToEoaTxHash: text,
  polymarketOrderId: text,
  status: text not null,                // see §3 state machine
  filledShares: numeric,
  filledAvgPriceBps: integer,
  failureReason: text,
  betKind: text not null default 'open', // 'open'|'close'
  parentBetId: text,                    // for closes: the original open bet
  createdAt, updatedAt
}

// 4. Position
predictionMarketPositions {
  id: text PK,
  userId: text not null,
  marketId: text not null,
  outcomeTokenId: text not null,
  side: text not null,
  sizeShares: numeric not null,
  entryPriceAvgBps: integer not null,
  entryStakeUsdc: numeric not null,
  openingBetId: text ref bets.id,
  closingBetId: text ref bets.id,
  currentValueUsdc: numeric,
  status: text not null,                // 'open'|'closing'|'closed'|'resolved'
  resolvedOutcome: text,
  realizedPnlUsdc: numeric,
  openedAt, closedAt
}
```

**Migration journal note (per CLAUDE.md):** assign `when ≥ 1778889600004` to keep monotonicity intact. Verify column existence after `db:migrate`.

## 9. Env additions (`predictionMarketEnv.ts`)

```ts
betsEnabled: bool("PREDICTION_MARKETS_BETS_ENABLED", false),
minStakeUsdc: num("PREDICTION_MARKETS_MIN_STAKE_USDC", 1),
maxStakeUsdc: num("PREDICTION_MARKETS_MAX_STAKE_USDC", 100),
maxOrderDriftBps: num("PREDICTION_MARKETS_MAX_ORDER_DRIFT_BPS", 200),
orderSlippageBps: num("PREDICTION_MARKETS_ORDER_SLIPPAGE_BPS", 50),
unfilledTimeoutMs: num("PREDICTION_MARKETS_UNFILLED_TIMEOUT_MS", 30_000),
bridgeTimeoutMs: num("PREDICTION_MARKETS_BRIDGE_TIMEOUT_MS", 90_000),
positionPollIntervalMs: num("PREDICTION_MARKETS_POSITION_POLL_INTERVAL_MS", 5 * 60 * 1000),
betIntentTtlMs: num("PREDICTION_MARKETS_INTENT_TTL_MS", 60 * 60 * 1000),
clobApiBase: str("PREDICTION_MARKETS_CLOB_API", "https://clob.polymarket.com"),
maticBootstrapWei: str("PREDICTION_MARKETS_MATIC_BOOTSTRAP_WEI", "50000000000000000"), // 0.05 MATIC for one-time approvals
betChainId: num("PREDICTION_MARKETS_BET_CHAIN_ID", 137), // Polygon — chain-agnostic-pattern compliant
```

Polymarket exchange/CTF/NegRisk addresses go into `chainConfig.ts` alongside the Polygon entry, **not inline** (per CLAUDE.md chain-agnostic rule).

## 10. Relay-specific implementation notes

The existing Relay client (`relayClient.ts`) is `EXACT_INPUT` only and does not poll bridge completion. Stage 4 needs:

- **`EXACT_OUTPUT` mode** — destination receives a precise USDC amount. Source amount = quoted input (varies with rate + fees).
- **Recipient ≠ user** — quote `recipient = SCA on Polygon` (not the EOA).
- **Destination gas paid by solver** — confirmed standard Relay behavior; no flag needed (verified during impl). The recipient does not need to pre-hold MATIC for the USDC delivery itself; this only matters for the *EOA gas dust* in setup, where destination = EOA and we ask Relay to deliver MATIC, not USDC.
- **Intent status polling** — Relay returns a `requestId`; poll `GET /intents/status/{requestId}` (or equivalent) until `status=success`. Implement `awaitIntent(requestId, timeoutMs)`.

**TODO during implementation:** confirm against Relay's live docs at `docs.relay.link` (timed out at planning time):
1. Exact field name for `EXACT_OUTPUT` (likely `tradeType: "EXACT_OUTPUT"` based on existing client's `EXACT_INPUT`).
2. Whether MATIC delivery to an EOA destination is a first-class quote (origin USDC → destination MATIC native) or requires `useExternalLiquidity` / a `txs` post-bridge unwrap.
3. Status-polling endpoint shape and terminal states (`success`/`failure`/`refund`).

If MATIC-direct-to-EOA isn't supported, fallback for setup `gas_funded`: solver delivers MATIC to **Polygon SCA**, Polygon SCA does `transfer(EOA, dust)` UserOp (paymaster-sponsored). Same end-state, one extra hop.

## 11. HTTP endpoints (consumed by the mini-app)

All under `/predictionMarket/*`, authenticated with the existing privy-auth middleware.

| Method | Path | Purpose |
|---|---|---|
| GET | `/state/:userId` | Returns setup status + in-flight bets + open positions for resumability. |
| GET | `/intent/:id` | Fetch chat-side intent (side, stake, refPrice). |
| POST | `/setup/:step` | Persist setup-step artifact (sca address, bridge intent id, approvals tx hashes, polymarket creds). Idempotent. |
| GET | `/bet/:id` | Fetch current bet state. |
| GET | `/bet/:id/bridge-status` | BE-polled Relay status, normalized. |
| POST | `/bet/:id/transition` | Generic state transition with artifact (txHash / bridgeIntentId / etc). Validates legal transition. |
| POST | `/bet/:id/drift-detected` | FE reports live price drifted >threshold; BE pauses execution and re-prompts in chat. |
| POST | `/bet/:id/finalize` | FE signals terminal state; BE renders receipt card. |
| GET | `/orderbook/:tokenId` | Live Polymarket top-of-book passthrough (cached ~2s). |
| POST | `/order/place` | FE POSTs signed EIP-712 order; BE attaches HMAC creds, forwards to Polymarket. |
| POST | `/order/sell` | Same as place but for closes. |
| POST | `/order/cancel/:polymarketOrderId` | Cancel an unfilled or partial. |
| GET | `/positions/:userId` | List open positions, with current quote + unrealized PnL. |
| POST | `/position/:id/finalize` | FE signals close terminal state. |

## 12. Failure modes

| Failure | Detection | Handling |
|---|---|---|
| Bridge times out | Relay status not `success` within `bridgeTimeoutMs` | `FAILED:bridge_timeout`. Background reconciliation: when intent eventually resolves, USDC arrives in SCA — trigger `creditAndOfferRetry` so user can re-attempt with the now-on-Polygon balance. No fund loss. |
| Bridge solver refund | Relay status `refund` | `FAILED:bridge_refunded`. User notified; funds returned on Avax. |
| Bridge under-delivers (slippage / fee variance) | Delivered USDC < stake | `FAILED:bridge_underdelivered`. Refund EOA dust unused; SCA holds the partial. Surface "received $X instead of $Y, retry with smaller stake?" |
| SCA→EOA UserOp fails | bundler / paymaster error | Retry once. If persistent → `FAILED:sca_to_eoa`. Funds remain in SCA, no loss. |
| Polymarket order signing fails (creds invalid) | adapter 401 | Mark `polymarketCredsEnc` stale, re-trigger `authed` setup step in mini-app, retry. |
| Polymarket API 5xx / timeout | adapter wrapper | Exponential retry (max 3, ~6s total). On exhaustion → `FAILED:polymarket_unavailable`. EOA holds USDC; auto-refund EOA→SCA on next mini-app open or by reconciliation job. |
| Order doesn't match within `unfilledTimeoutMs` | poller | Cancel via `/order/cancel`, status → `UNFILLED`. Refund USDC EOA→SCA. |
| Order partial-fills | poller | Status `PARTIAL`. Position written for filled portion. Cancel remainder, refund leftover USDC EOA→SCA. |
| Mini-app closed mid-flow | client unmount | BE keeps state. `/state/:userId` exposes resume point. |
| Price drift > `maxOrderDriftBps` | FE pre-sign quote check + POST `/bet/:id/drift-detected` | BE renders inline-keyboard re-confirm in chat. |
| User has no funds on Avalanche | balance check at amount-reply step | Reject at amount step ("Add USDC to bet — [Deposit]"). No intent row written. |
| Two concurrent bets from same user | unique `clientOrderId`; advisory lock per `userId` | Second intent queues; mini-app handles serially. |
| Polymarket rejects EOA address | submission error | Approvals missing — mark setup step regression and re-run from `approved`. |

## 13. Sequencing (BE-only)

1. Polygon onboarding extension (SCA + delegated key on Polygon, reusing `session-delegation`) — independent, ship behind a flag first and verify against existing wallet flows.
2. Relay client extension (`EXACT_OUTPUT`, status poller, intent-status normalizer) — independent, unit-testable.
3. Polymarket adapter (sign helpers, place, cancel, position fetch, orderbook, L1/L2 auth) — independent.
4. Schema + repos.
5. HTTP endpoints (§11).
6. Place-bet capability (composes 1+2+3+5) + bet-intent chat flow.
7. Receipt result-card emission (BE side).
8. Position poller.
9. Close-position capability + close result-card emission.
10. End-to-end on testnet (Polygon Mumbai if Polymarket has a testnet endpoint; otherwise small-stake mainnet).

## 14. Out of scope for v1

- Order types beyond GTC limit at ref-price + slippage.
- Multi-leg / scaling orders / partial-stake fills across multiple bets.
- Cross-position netting / hedging UI.
- Auto-sweep of Polygon SCA balance back to Avalanche when idle.
- Loyalty rewards on bets (hooks emitted; UI deferred).
- Polymarket NegRisk multi-outcome markets (binary YES/NO only — matches stage 1–3 universe filter).

## 15. Open items to confirm before / during impl

1. **Polymarket testnet availability.** If none, plan for mainnet $1-stake validation runs.
2. **Relay MATIC-direct-to-EOA support** for setup `gas_funded` (fallback documented in §10).
3. **Polymarket L1 message format** — verify the exact EIP-712 domain + types from the current `clob-client` source.
4. **Polymarket signature type for plain ECDSA EOA maker** — likely `EOA` (value `0`) per the SDK enum; confirm.
5. **Polygon paymaster funding** — ensure paymaster has POL gas budget for SCA UserOps (deploy + transfers + refunds). Alert on low balance.
6. **Concurrent bet limit** — start at 1 in-flight bet per user; revisit if users hit it.

---

**Status:** ready to implement once §15 items 2–4 are confirmed and the FE construction doc (`fe/privy-auth/constructions/2026-05-07-prediction-markets-stage4.md`) is reviewed alongside this one. Sequencing in §13 lets onboarding (#1) and Relay extension (#2) start in parallel without blocking on Polymarket specifics.
