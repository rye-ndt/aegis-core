# Zero-sign Polymarket bets — Backend

Date: 2026-05-15
Status: plan
Pair: `fe/privy-auth/constructions/2026-05-15-zero-sign-bet-fe.md`. The two plans ship together; either side alone is not deployable. The BE-side schema migration ships first so a partially-rolled-out FE keeps working against the old endpoints until the cutover commit lands.

## Why

`/send` and `/swap` are zero-sign in the codebase's idiomatic sense: BE writes one or more `sign_request` rows with `autoSign: true`, the chat deep-link opens the mini-app, `SignHandler` auto-signs each step, the mini-app closes. The user taps once in chat.

`/bet` does not match this shape today. `PlaceBetHandler.tsx` (~580 lines) is a FE-driven state machine that:

- decides which BE endpoint to call next (`/setup/:step`, `/bet/:id/transition`, `/bet/:id/finalize`, `/bet/:id/drift-detected`, `/bet/:id/refund`, `/order/place`, `/order/sell`, `/bet/:id/bridge-status`, `/intent/:id`, `/state`, `/positions`)
- polls Polymarket via the BE (`pmApi.orderbook`)
- signs both UserOps and raw EOA primitives in two different code paths
- has its own phase enum, drift screen, refund screen, in-flight screen

The Polymarket setup steps (gas funding, USDC approvals, CTF approvals, CLOB auth) and the per-bet steps (SCA→EOA transfer, order signing, residual sweep) are all things that *could* be expressed as queued sign-requests against the existing `signingRequest` infrastructure, but today they aren't. This plan rewrites the bet flow to use that infrastructure end-to-end.

Non-negotiable: **BE holds no key material.** Session-key privkey, CLOB API secret/passphrase, and every signature stay FE-local. BE only ever sees signed artifacts (UserOp hashes, raw tx hashes, EIP-712 sigs, and Polymarket order IDs returned by the FE after it talks to CLOB directly). This plan does not relax that property.

## Outcome

Once shipped, the bet flow looks exactly like `/swap`:

```
chat (confirm) → BE PredictionMarketBetCapability.run()
              → enqueues sign_request #1 (autoSign)
              → chat sends mini-app deep-link
mini-app opens → SignHandler picks up #1 → auto-signs → POST /response
              → BE advances state → enqueues sign_request #2
              → SignHandler.fetchNextRequest() → auto-signs #2 → …
              → terminal: mini-app closes
```

No bet-specific FE screens. No FE-driven state machine. No FE→BE→CLOB hop for order submission. No new endpoints with bet-specific verbs. `SignHandler` learns two new signing primitives (`eoa_tx`, `eip712`); everything else collapses into the same scaffolding `/send` and `/swap` already use.

## Scope (in / out)

In scope:

- Extend the `signing_requests` schema + repo + `/response` handler with two new `kind`s: `eoa_tx`, `eip712`. Existing `userop` shape is unchanged.
- Rewrite `PredictionMarketBetUseCase` to drive the bet through `sign_request` enqueues + advances, rather than exposing per-step REST endpoints called by the FE.
- Rewrite `PredictionMarketSetupUseCase` similarly — first-bet setup becomes a chained sign-request bundle ending with the FE writing CLOB creds into its own CloudStorage.
- Move drift gating to the BE side of each order-sign enqueue (BE reads the public Polymarket orderbook before issuing the sign, declines the issue with a chat message if drift exceeded).
- Delete the FE-callable bet-orchestration HTTP routes (`/setup/:step`, `/bet/:id/transition`, `/bet/:id/finalize`, `/bet/:id/drift-detected`, `/bet/:id/refund`, `/order/place`, `/order/sell`, `/bet/:id/bridge-status`). Keep the read-only ones (`/state`, `/positions`, `/intent/:id`, `/bet/:id`).
- Capability outputs `nextActions` opening the mini-app deep-link, matching `/swap` / `/send` patterns. No `place_bet:<findingId>:A|B` verb resurrection — the deep-link target is the generic mini-app URL; the queue is keyed by user.
- `polymarketAdapter` collapses to a read-only client (orderbook + order-status + position-state — all public Polymarket endpoints; no auth headers, no order POSTs).
- `polymarketPositionPollerJob` survives, now BE-authoritative for fill detection.
- Background job that re-enqueues residual-sweep sign-requests for any bet with `refundRequired && !refundTxHash` whose latest sign-request expired.

Out of scope (this plan):

- BLOCKER-1 (sudo policy → call policy). The Polygon session-key install path uses whatever policy mode is current. Adding Polygon to the spending-limit policy registry is a config item, not a flow item.
- BLOCKER-3 (maxUint256 → per-bet exact approvals). Easy follow-up: swap the one-time `eoa_tx` approval bundle for per-bet `approve(stake)` + `approve(0)` flanking the order sign. Out of scope here to keep the plan focused.
- Cross-chain USDC inventory. If the user has USDC on Avalanche, the bridge step survives as a BE-side action; it produces no `sign_request` because nothing on the FE needs to sign it (the bridge is initiated by a UserOp on the source chain via the existing send flow, or by the user manually before betting). Document the contract; do not redesign it.
- Paper-bet path. Already removed 2026-05-15.

## Non-custodial invariants (must hold)

1. BE never reads, writes, or transmits a session-key privkey.
2. BE never reads, writes, or transmits CLOB `apiKey` / `secret` / `passphrase`. The FE handles CLOB authentication and order submission. BE only learns the resulting `polymarketOrderId` (a public, post-submission identifier).
3. BE never reads or writes an EIP-712 signature except to mark the corresponding `sign_request` complete. Signatures are not retained beyond the sign-request row's lifetime (which is short — cache-only).
4. BE only consumes **public** Polymarket endpoints: orderbook, order status by id, positions by proxy address. Anything that requires HMAC headers stays FE-side.

A CI grep gate (existing pattern, see BLOCKER-2 acceptance) is extended to fail on any new BE reference to `apiKey`, `passphrase`, `clobAuth`, `signature` outside of `signingRequestRepo` and tests. Tracked separately; mentioned here so the next contributor wires it.

## Design

### 1. `signing_requests` — typed kind

Today the row carries `(requestId, userId, to, value, data, chainId, autoSign, status, …)` and the FE always treats it as a UserOp. Add a discriminator:

```ts
// be/src/use-cases/interface/signing/SigningRequest.ts (or wherever the type lives)

type SigningRequestKind = 'userop' | 'eoa_tx' | 'eip712';

interface BaseSigningRequest {
  requestId: string;
  userId: string;
  chainId: number;
  autoSign: boolean;
  status: 'pending' | 'completed' | 'rejected' | 'expired';
  createdAt: Date;
}

interface UseropSigningRequest extends BaseSigningRequest {
  kind: 'userop';
  to: Address;
  value: string;      // bigint as decimal string
  data: Hex;
}

interface EoaTxSigningRequest extends BaseSigningRequest {
  kind: 'eoa_tx';
  to: Address;
  value: string;
  data: Hex;
  // Polygon-only for now; chainId carries it.
}

interface Eip712SigningRequest extends BaseSigningRequest {
  kind: 'eip712';
  purpose: 'clob_auth' | 'polymarket_order';
  domain: TypedDataDomain;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>; // BigInts pre-stringified for JSON
  // Anti-replay metadata:
  expiresAt: Date;                  // hard upper bound, BE refuses /response after
  betId?: string;                   // for order purpose, the bet this signs
  positionId?: string;              // for sell-order purpose
}
```

Migration: add `kind`, `purpose`, `domain`, `types`, `primary_type`, `message_json`, `expires_at`, `bet_id`, `position_id` columns to `signing_requests`. Backfill `kind = 'userop'` for existing rows. Drizzle journal `when` must be one tick above the prior max — verify with `information_schema.columns` after `db:migrate` (CLAUDE.md migrations rule).

`signingRequestRepo` gains a `kind`-aware insert helper and the existing `findById` returns the union type. Adapters that today only consume `userop` fields still compile after a single TS narrowing branch.

### 2. `/response` handler — kind-aware

Today `/response` accepts `{ requestId, rejected?, txHash?, errorCode?, errorMessage?, errorRaw? }`. Extend:

```ts
type ResponseBody =
  | { requestId; requestType: 'sign'; rejected: false; txHash: Hex; userOpHash?: Hex }   // userop
  | { requestId; requestType: 'sign'; rejected: false; txHash: Hex }                      // eoa_tx
  | { requestId; requestType: 'sign'; rejected: false;
      signature: Hex; signer: Address;
      polymarketOrderId?: string }                                                        // eip712
  | { requestId; requestType: 'sign'; rejected: true; errorCode; errorMessage; errorRaw }
```

The handler dispatches on the row's `kind` (not on the response shape) and:

- `userop` / `eoa_tx`: verify `txHash` format, mark complete, fire the use-case advance.
- `eip712 purpose=clob_auth`: verify `signature` recovers to a `signer` address that matches the user's session-key EOA (we already know this address from the BE's record of session-key installs). Mark complete. The signature is discarded (BE has no use for it).
- `eip712 purpose=polymarket_order`: verify `signature` recovers, require `polymarketOrderId` present (the FE must have called CLOB before /response — it's our proof the order is live). Persist `polymarketOrderId` on the `prediction_market_bets` row by linking through `betId`. Mark complete.

Signature recovery is local crypto (viem's `verifyTypedData` / `recoverTypedDataAddress`). No external call. No privkey ever touches BE.

Anti-replay: `expires_at` check. `kind`-specific uniqueness — for `polymarket_order`, refuse if `betId` already has a completed `eip712 polymarket_order` row (one signed order per bet attempt; closing/retry uses a new bet row).

### 3. `PredictionMarketBetUseCase` — driver

The capability `PlaceBetCapability` already exists for the confirm card. Today its confirm path calls `PredictionMarketBetUseCase.start(intentId)` which marks the intent `executing` and creates a `prediction_market_bets` row in `INITIATED`. After this change, `start()` also kicks the state machine:

```ts
class PredictionMarketBetUseCase {
  async start(intentId: string): Promise<void> {
    const intent = await this.intentRepo.findById(intentId);
    if (this.betRepo.hasInFlight(intent.userId)) throw new BetInFlight();

    const setupComplete = await this.setupRepo.isComplete(intent.userId, POLYGON);
    if (!setupComplete) await this.setupUseCase.beginIfMissing(intent.userId);

    const bet = await this.betRepo.create({
      intentId, userId: intent.userId, /* … */, status: 'INITIATED',
    });
    await this.advance(bet.id);
  }

  /** Called by the /response handler after each sign_request completes,
   *  AND on idempotent re-entry (mini-app re-open, BE restart). */
  async advance(betId: string): Promise<void> {
    const bet = await this.betRepo.findById(betId);
    if (TERMINAL.has(bet.status)) return;

    // Setup is a precondition. If not complete, advance setup first.
    if (!await this.setupRepo.isComplete(bet.userId, POLYGON)) {
      return this.setupUseCase.advance(bet.userId);
    }

    // Bridge is a separate BE-driven step. If USDC isn't on Polygon SCA yet,
    // kick the bridge and exit — the bridge poller calls advance() again
    // when bridge finalizes.
    const balance = await this.publicPolygon.scaUsdcBalance(bet.userId);
    if (balance < bet.stakeUsdcRaw) {
      return this.bridgeUseCase.beginIfMissing(bet);   // no sign_request needed
    }

    switch (bet.status) {
      case 'INITIATED':
      case 'BRIDGING':
      case 'BRIDGED':
        return this.enqueueScaToEoa(bet);                 // userop
      case 'SCA_TO_EOA':
        return this.enqueueOrderSign(bet);                // eip712 purpose=polymarket_order
      case 'ORDER_SIGNED':
      case 'ORDER_SUBMITTED':
        return this.beginFillPoll(bet);                   // no sign_request, BE polls
      case 'FILLED':
      case 'PARTIAL':
      case 'UNFILLED':
      case 'FAILED':
        return this.finalize(bet);
    }
  }
}
```

`advance()` is **idempotent**. Calling it twice for the same bet at the same status produces at most one open `sign_request` (the row insert is `ON CONFLICT (bet_id, status) DO NOTHING` for the deterministic slots). This is the invariant that lets the mini-app re-open mid-flight without firing duplicate UserOps — same property `/swap` relies on.

#### `enqueueScaToEoa`

Builds the calldata for `usdc.transfer(eoaAddress, stake)` and inserts a `userop` sign-request:

```ts
const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer',
  args: [bet.eoaAddress, parseUnits(bet.stakeUsdc, 6)] });
await this.signingRequestRepo.insert({
  kind: 'userop',
  userId: bet.userId,
  chainId: POLYGON_CHAIN_ID,
  to: USDC_POLYGON,
  value: '0',
  data,
  autoSign: true,
  betId: bet.id,                    // links the row to the bet for advance()
});
```

When the FE `/response`'s in with `txHash`, the handler records `scaToEoaTxHash` on the bet, transitions to `SCA_TO_EOA`, and calls `advance(betId)` which enqueues the order sign.

#### `enqueueOrderSign`

This is where drift gating moves. Read the public orderbook (BE has a `polymarketReadAdapter` for this), check `|live - bet.refPriceBps| <= DRIFT_BPS`, and either:

- enqueue the `eip712 polymarket_order` sign-request with the order body computed against the **live** mid (not the stale ref), OR
- transition the bet to `FAILED { failureReason: 'drift' }`, post a chat message ("price moved, confirm again"), and skip the enqueue.

```ts
const ob = await this.polymarketRead.orderbook(bet.outcomeTokenId);
if (Math.abs(ob.midBps - bet.refPriceBps) > DRIFT_BPS) {
  await this.betRepo.update(bet.id, { status: 'FAILED', failureReason: 'drift' });
  await this.chatNotifier.postDriftMessage(bet);
  return;
}
const limitPriceBps = applySlippage(ob.midBps, ORDER_SLIPPAGE_BPS, 'BUY');
const shares = sharesForStake(bet.stakeUsdc, limitPriceBps);

const orderMessage = {
  salt: randomSalt(),
  maker: bet.eoaAddress, signer: bet.eoaAddress,
  taker: ZERO_ADDRESS,
  tokenId: bet.outcomeTokenId,
  makerAmount: usdcAmount(shares, limitPriceBps),
  takerAmount: shares,
  expiration: '0', nonce: '0', feeRateBps: '0',
  side: 0, signatureType: 0,
};

await this.signingRequestRepo.insert({
  kind: 'eip712',
  purpose: 'polymarket_order',
  userId: bet.userId,
  chainId: POLYGON_CHAIN_ID,
  domain: ctfExchangeDomain(POLYGON_CHAIN_ID),
  types: ORDER_TYPES,
  primaryType: 'Order',
  message: orderMessage,
  autoSign: true,
  betId: bet.id,
  expiresAt: addSeconds(new Date(), 60),
});
await this.betRepo.update(bet.id, { status: 'ORDER_SIGNED', orderMessage });
```

The FE signs the typed data, calls Polymarket CLOB `/order` directly with its FE-held HMAC creds, gets `polymarketOrderId`, posts it back in `/response`. The `/response` handler verifies signature recovery == `bet.eoaAddress`, stores `polymarketOrderId` on the bet, transitions to `ORDER_SUBMITTED`, and `advance()` kicks the fill-poll branch.

#### `beginFillPoll`

`polymarketPositionPollerJob` is already periodic. Add a "watch list" the use-case writes to: `pending_polymarket_orders(betId, polymarketOrderId, deadline)`. The poller reads the watch list, queries `clob.polymarket.com/data/order/:id` (public), and on terminal:

- FILLED: transition bet, derive position row, mark watch row done. Post chat success message.
- PARTIAL: same, plus set `refundRequired = true` (residual USDC stranded on EOA). `advance()` then routes to `enqueueResidualSweep`.
- UNFILLED / cancelled: transition bet to UNFILLED, `refundRequired = true`, `advance()` routes to sweep.

Deadline = `bet.createdAt + FILL_TIMEOUT_MS`. After deadline, force `UNFILLED` and sweep.

#### `enqueueResidualSweep`

For `PARTIAL | UNFILLED | FAILED` with `scaToEoaTxHash` set:

```ts
// Read EOA USDC balance via public Polygon RPC. If zero, mark refunded and exit.
const bal = await this.publicPolygon.eoaUsdcBalance(bet.eoaAddress);
if (bal === 0n) {
  await this.betRepo.update(bet.id, { refundRequired: false, refundTxHash: ZERO_HASH });
  return;
}
await this.signingRequestRepo.insert({
  kind: 'eoa_tx',
  userId: bet.userId,
  chainId: POLYGON_CHAIN_ID,
  to: USDC_POLYGON,
  value: '0',
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer',
                             args: [bet.scaAddress, bal] }),
  autoSign: true,
  betId: bet.id,
});
```

On `/response` txHash arrival, set `refundTxHash` and `refundRequired = false`. Done.

The follow-up job mentioned in scope re-enqueues if the sign-request expired (the mini-app never opened to consume it within `expiresAt`).

### 4. `PredictionMarketSetupUseCase` — first-bet bundle

Today's setup steps (`pending → sca_deployed → gas_funded → approved → authed → complete`) become a fixed chain of sign-requests emitted on first bet attempt and consumed in order by `SignHandler.fetchNextRequest()`.

```ts
async advance(userId): Promise<void> {
  const setup = await this.setupRepo.find(userId, POLYGON);
  switch (setup.step) {
    case 'pending':       return this.transitionTo('sca_deployed', userId);
    case 'sca_deployed':  return this.enqueueGasFunding(userId);
    case 'gas_funded':    return this.enqueueApprovals(userId);
    case 'approved':      return this.enqueueClobAuth(userId);
    case 'authed':        return this.complete(userId);
  }
}
```

- `pending → sca_deployed`: BE-only, no enqueue. The Polygon SCA address is deterministic from the user's Privy DID (Kernel's factory deployment is CREATE2; address known before deploy). Record it and advance.
- `sca_deployed → gas_funded`: enqueue a `userop` (`{kind:'userop', to: eoaAddress, value: minMatic, data: '0x'}` on Polygon) that sends a small amount of MATIC from SCA to EOA. **This requires the Polygon SCA to hold MATIC.** Two options, picked at config time:
  - (a) The SCA's bridge step (already part of bet-launch path) bridges a tiny extra MATIC alongside the USDC. `relayBridgeAdapter` already supports this — add `extraGasToken`.
  - (b) Subsidize via a separate paymaster-funded UserOp where the bundler attaches a MATIC top-up via a custom paymaster mode. Not preferred; option (a) reuses existing inventory plumbing.
  Either way, the **sign** part of "gas funding" is a normal UserOp; the FE doesn't know it's setup-specific.
- `gas_funded → approved`: enqueue **three** `eoa_tx` sign-requests in sequence (`USDC.approve(ctfExchange, maxUint256)`, `USDC.approve(negRiskExchange, maxUint256)`, `CTF.setApprovalForAll(ctfExchange, true)`). `SignHandler.fetchNextRequest()` chains them. After the third txHash arrives the setup transitions to `approved`. (Per-bet exact approvals — BLOCKER-3 — is the future replacement; this plan preserves the existing one-time approval behaviour to keep scope contained.)
- `approved → authed`: enqueue **one** `eip712 purpose=clob_auth` sign-request. The FE signs the ClobAuth typed data, calls Polymarket `/auth/api-key` with the sig, receives `{apiKey, secret, passphrase}`, **stores them locally** in CloudStorage (encrypted with the session-key password), then POSTs `/response { signature, signer, ok: true }` to close the sign-request. The BE verifies the signature recovers to the user's EOA, marks setup `authed`. The BE never sees the CLOB credentials.
- `authed → complete`: BE-only, no enqueue. Setup row marked complete.

The mini-app stays open the entire time. `SignHandler.fetchNextRequest()` polls until either a new sign-request appears or none is pending → close. This is the same loop swap uses.

### 5. Routes — what stays, what goes

Delete (FE no longer calls):

- `POST /predictionMarket/setup/:step`
- `POST /predictionMarket/bet/:id/transition`
- `POST /predictionMarket/bet/:id/finalize`
- `POST /predictionMarket/bet/:id/drift-detected`
- `POST /predictionMarket/bet/:id/refund`
- `POST /predictionMarket/order/place`
- `POST /predictionMarket/order/sell`
- `GET  /predictionMarket/bet/:id/bridge-status`

Keep (read-only, used by chat / debug UI):

- `GET /predictionMarket/state`
- `GET /predictionMarket/positions`
- `GET /predictionMarket/intent/:id`
- `GET /predictionMarket/bet/:id`
- `GET /predictionMarket/orderbook/:tokenId` *— still used by chat-side previews; the FE handler doesn't call it anymore but the chat capability does. Move BE-side if needed; mark deprecated for FE if not.*

Keep + extend:

- `POST /response` — now handles the three sign-request `kind`s.
- `GET  /signingRequests/next?afterRequestId=…` — unchanged; just returns whichever kind is next.

### 6. `polymarketAdapter` becomes read-only

`IPolymarketAdapter` collapses to:

```ts
interface IPolymarketReadAdapter {
  orderbook(tokenId): Promise<{ bidBps; askBps; midBps }>;
  orderStatus(id): Promise<{ status; filledShares?; avgPriceBps? }>;
  positions(proxyAddr): Promise<Position[]>;   // public endpoint, no auth
  markets(slug?): Promise<MarketSummary[]>;    // already used by scan
}
```

Everything that requires HMAC headers (`/order POST`, `/order DELETE`, `/auth/api-key POST`) gets deleted from the BE adapter. Construction docs from the historical adapter live as record; the new file uses only public endpoints.

The FE gets its own minimal CLOB submitter (see FE plan §3).

### 7. Capability output

`PlaceBetCapability.confirmCardArtifact` returns the same result-card with `nextActions` containing a single mini-app deep-link (no `findingId` / `side` in the URL — the queued sign-request carries the work). `ClosePositionCapability` likewise.

Today's `nextActions` for `/send` and `/swap` are the model. Match them exactly so the chat-side rendering needs zero changes.

### 8. Background job: stuck-bet sweeper

A periodic job (every 30s, same cadence as `polymarketPositionPollerJob`) walks bets where:

- `status` ∈ {INITIATED, BRIDGING, BRIDGED, SCA_TO_EOA, ORDER_SIGNED, ORDER_SUBMITTED} and `updatedAt < now - STUCK_BET_TIMEOUT_MS`, OR
- `refundRequired && !refundTxHash && updatedAt < now - REFUND_RETRY_INTERVAL_MS` and no open sign-request exists for the bet.

For each, calls `advance(betId)` to re-enqueue. Idempotent by §3's "one open sign-request per (bet, status) slot" invariant.

This is the BE-side guarantee that lets the user close the mini-app and reopen later without anything going stale.

### 9. Logging

Per CLAUDE.md mandatory logging. Every use-case method logs:

```ts
log.info({ step: 'bet-started', userId, betId }, 'bet-started');
log.info({ step: 'enqueue-sca-to-eoa', betId, requestId }, 'enqueued');
log.info({ step: 'order-signed', betId, requestId, polymarketOrderId }, 'order-signed');
log.info({ step: 'filled', betId, durationMs }, 'bet-filled');
log.error({ err, betId }, 'advance-failed');
```

Sign-request `/response` handler logs `kind`, `purpose`, `betId`, `durationMs`. Never log signatures, never log CLOB creds, never log session-key material. (Per existing privacy list.)

New metadata names introduced (record in `be/STATUS.md` after merge): `polymarketOrderId`, `orderMessage`, `clientOrderId` (the last was already there for legacy paths).

## Tasks (shippable slices)

Slice A — schema + repo + response handler (no behaviour change yet):

1. Drizzle migration adding `kind`, `purpose`, `domain_json`, `types_json`, `primary_type`, `message_json`, `expires_at`, `bet_id`, `position_id` to `signing_requests`. Backfill `kind='userop'`. **Verify with `information_schema.columns` per CLAUDE.md migrations rule.**
2. `SigningRequestKind` union, repo widening, `findById` returns union.
3. `/response` handler dispatch on `kind`. `userop` path unchanged. `eoa_tx` + `eip712` stubs return 501 until §B.
4. Unit tests on signature recovery for `eip712` paths (don't need a real EOA — generate one in test).

Slice B — BetUseCase rewrite, behind a feature flag (`PREDICTION_MARKETS_USE_SIGN_QUEUE`):

5. `PredictionMarketBetUseCase.advance(betId)` and the `enqueue*` helpers.
6. `enqueueResidualSweep` + stuck-bet sweeper job.
7. `/response` handler completes the `eoa_tx` / `eip712` paths, calls `advance(betId)`.
8. Replay tests in `predictionMarketsReplay.test.ts` updated to walk through the new state machine via fake sign-request completions.

Slice C — SetupUseCase rewrite, same flag:

9. `PredictionMarketSetupUseCase.advance(userId)` and the four enqueue helpers.
10. Bridge integration for gas funding (`relayBridgeAdapter` accepts MATIC alongside USDC, or a separate `gasBridgeUseCase`).

Slice D — capability + chat:

11. `PlaceBetCapability.confirmCardArtifact` flips to mini-app deep-link `nextAction`. Behind flag.
12. `ClosePositionCapability` likewise — issues a single `eip712 polymarket_order` sign-request (with `purpose='polymarket_order'`, `positionId` set, `message.side=1`) plus a follow-up `eoa_tx` sweep, no setup precondition.

Slice E — route deletion + adapter trimming:

13. Delete the FE-callable bet-orchestration routes. Smoke-test against the new FE that they're truly unused.
14. `IPolymarketAdapter` → `IPolymarketReadAdapter`. Remove HMAC code paths. Construction note in `be/src/adapters/implementations/output/predictionMarket/status.md` (if absent, create) documenting the read-only invariant.

Slice F — flag removal + cleanup:

15. Flip `PREDICTION_MARKETS_USE_SIGN_QUEUE` to default-on across envs.
16. Delete the old REST-driven branches. Delete `IPredictionMarketBetUseCase.transitionBet` etc.
17. `be/STATUS.md` entry describing the new flow, new metadata names, deleted routes.

Each slice is independently revertable. Slice A is deployable on its own and a no-op for behaviour. Slices B+C are behaviour-changing but gated. Slice D is the cutover. Slices E+F are cleanup.

## Risks + mitigations

- **Drift gate moves server-side; subject to BE clock skew vs. FE.** Mitigation: BE-side check is the only check (delete the FE one). BE reads orderbook within milliseconds of `enqueueOrderSign`. Skew is bounded.
- **`advance()` re-entrancy.** Mitigation: a per-`(userId, betId)` advisory lock on the row during transition. PostgreSQL `pg_try_advisory_xact_lock` keyed on a hash of the bet id is sufficient. Tested via concurrent-`/response` integration test (two pods serving two `/response` arrivals racing on the same bet — should produce one transition, one no-op).
- **Sign-request expiry while mini-app is closed.** Mitigation: stuck-bet sweeper re-enqueues. The replacement row has a fresh `expiresAt`. The FE's `findRecentBroadcast` dedupe in `SignHandler` is per-`requestId`, so a fresh row gets a fresh attempt cleanly.
- **EIP-712 message JSON has BigInts.** Mitigation: stringify on the way in (already the pattern for `BetRow.stakeUsdc`). The FE parses back with `BigInt()` before signing. Snapshot tests on domain + types prevent drift.
- **`polymarketOrderId` is returned by the FE — what if a malicious FE lies?** Mitigation: the BE poller verifies the order id exists on Polymarket (public endpoint) before treating the bet as `ORDER_SUBMITTED` for fill-timeout purposes. A bogus id ages out → bet fails → sweep refunds. Worst case: a single bet wasted; no funds at risk because the underlying signed order is what would have moved USDC, and that signature went directly to Polymarket from the FE.
- **CLOB creds in CloudStorage encrypted with `privyDid`.** Mitigation: not this plan's concern — BLOCKER-2 covers it for the session-key blob and the same fix transparently applies to CLOB creds (they use the same encryption helper).
- **The `eip712.message` field is a Record of bigints-as-strings; an attacker with DB write access could forge a `signing_requests` row pointing the user at a fake order.** Mitigation: same threat as BLOCKER-4 against `/send`. Out of scope here; the existing mitigations (BE-signed sign-request envelopes when added) cover this row type identically.

## Acceptance

- `/bet $5 yes` → chat confirm tap → mini-app opens → no modals → closes after ≤30s on first bet (setup chain), ≤10s on subsequent bets. No tap inside the mini-app.
- `/positions` shows the new bet within 60s of fill.
- Force-close mini-app mid-flow, reopen 5 minutes later → flow resumes from the BE's canonical state via the stuck-bet sweeper. No double-charge, no double-bet, no orphaned approval.
- Drift > `DRIFT_BPS` between confirm and `enqueueOrderSign` → bet fails with `failureReason: 'drift'`, chat posts the "price moved, confirm again" message, no order goes to Polymarket.
- Partial fill → residual sweep auto-runs in the same mini-app session if user is still open, otherwise on next open or via sweeper.
- BE log of a full happy-path bet contains: 0 CLOB credential references, 0 signature contents, ≥1 `polymarketOrderId`, ≥1 UserOp hash, ≥3 EOA tx hashes (on first bet — approvals; ≥1 on subsequent bets — sweep when applicable).
- Replay test (`predictionMarketsReplay.test.ts`) covers: happy path FILLED, PARTIAL + sweep, UNFILLED + sweep, FAILED at drift, BetInFlight on parallel attempt, idempotent `advance()` on duplicate `/response`.
- `grep -rE "(clobAuth|apiKey|passphrase|signature)" be/src/adapters/implementations/output/predictionMarket/` returns no production-code matches outside the read-only adapter's irrelevant fields.

## Status.md updates after merge

- `be/STATUS.md`: top-of-file entry "Prediction markets — zero-sign queue rewrite — 2026-05-…". List deleted routes, new sign-request kinds, new metadata names, removed `IPolymarketAdapter` surface.
- `be/src/adapters/implementations/output/predictionMarket/status.md` (create if absent): record the read-only invariant for the polymarket adapter and the BE-no-keys property.
- `be/src/use-cases/interface/predictionMarket/status.md` (create if absent): document the `advance()` idempotency invariant and the per-`(bet, status)` slot uniqueness.
