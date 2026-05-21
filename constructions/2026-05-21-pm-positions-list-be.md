# Prediction-Market Positions list — Backend

Date: 2026-05-21
Status: plan
Pair: `fe/privy-auth/constructions/2026-05-21-pm-positions-list-fe.md`. Ship together.

## Why

Today the mini-app has no way to enumerate or close a prediction-market position. The only entry point is a Telegram position card produced by `ClosePositionCapability`. The FE plan adds an in-app positions list (mirroring `YieldPositions`) and a tap-to-close bottom sheet. This BE plan exposes the two HTTP surfaces that flow needs:

1. **Read** — `GET /predictionMarket/positions` already exists; we **enrich** the payload so each row carries the market question + outcome label. Today the FE would only see opaque `marketId` / `outcomeTokenId` hashes.
2. **Close from mini-app** — add two routes that reuse the existing `previewClose` / `initiateClose` use-case methods. **No new capability, no new use-case method, no new chat flow.**

The Telegram `close_position` / `confirm_close` / `cancel_close` callback path (in `ClosePositionCapability`) is untouched. Both paths converge on the same use-case methods and therefore the same DB state machine — there is exactly one way to close a position; we are just adding a second front door.

## Non-goals

- No new chat capability, no new tool, no new LLM verb.
- No change to the sign-queue / `advance()` / SignHandler contract.
- No support for cancelling pre-execution bet intents from the mini app (positions are post-fill objects; the user said "open positions"). `POST /predictionMarket/intent/:id/cancel` already exists for intent-stage cancel and is out of scope.
- No live orderbook quote on the list endpoint. Per-card quote happens only on tap (the existing `previewClose` path).
- No live PnL recompute. We return whatever the reconciler/finalizer last wrote into `current_value_usdc_cents`.

## Convention adherence

| Concern          | Existing convention reused                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Position read    | `IPredictionMarketBetUseCase.listOpenPositions(userId)` — unchanged signature, output type extended.                                                                                                                                                                                                                           |
| Close preview    | `IPredictionMarketBetUseCase.previewClose(userId, positionId)` — unchanged.                                                                                                                                                                                                                                                    |
| Close initiate   | `IPredictionMarketBetUseCase.initiateClose({ userId, positionId, clientOrderId, refPriceBps })` — unchanged. New HTTP wrapper mints `clientOrderId` server-side (`newUuid()`) and uses `preview.bestBidPriceBps` as `refPriceBps`, identical to `ClosePositionCapability` confirm branch (`closePositionCapability.ts:80-87`). |
| Mini-app handoff | Response body `{ enqueuedRequestId }`; FE navigates to `?requestId=<id>` (same contract as `openMiniAppArtifact`).                                                                                                                                                                                                             |
| Auth             | `extractUserId(req)` Bearer flow used by all `handlePm*` handlers.                                                                                                                                                                                                                                                             |
| Errors           | Use-case throws domain errors (`POSITION_NOT_FOUND`, `POSITION_WRONG_STATUS`, `BET_IN_FLIGHT`); HTTP layer maps to `{409, code, message}` JSON. Mirrors `handlePmCancelIntent` style.                                                                                                                                          |
| Logging          | `createLogger("httpServer")` already in file; emit `step` events with `reqId`, `userId`, `positionId`.                                                                                                                                                                                                                         |

## Design

### 1. Enrich `listOpenPositions` payload (Slice 1)

`PositionRow` has `marketId`, `outcomeTokenId`, `side` but no human label. The FE needs:

- `marketQuestion: string` — the question text for the row's `marketId`.
- `outcomeLabel: string` — `"YES"` / `"NO"` (mapped from `side` for binary markets; pass through for multi-outcome).

Approach: **return a new DTO**, do not widen `PositionRow`. The DB row is unchanged; only the HTTP response shape grows.

```ts
// be/src/use-cases/interface/predictionMarket/IPredictionMarketBetUseCase.ts (new export)

export interface PositionListItem extends PositionRow {
  marketQuestion: string;
  outcomeLabel: string; // "YES" | "NO" | raw outcome name
}
```

Add a sibling method on the use-case so the HTTP handler doesn't have to do the join itself:

```ts
listOpenPositionsForDisplay(userId: string): Promise<PositionListItem[]>;
```

Implementation in `PredictionMarketBetUseCase` (`be/src/use-cases/predictionMarket/...`):

1. Call `repo.listOpenPositionsForUser(userId)`.
2. Collect distinct `marketId`s, batch-load `RawMarket` rows via `predictionMarketRepository.getMarketsByIds(ids)` — **new repo method, see Slice 1b.**
3. Map `side` → `outcomeLabel`: the universe is filtered to binary markets at ingestion (`RawMarket.outcomesCount === 2` always — see `PredictionMarketTypes.ts:26`), so `outcomeLabel` is purely `side.toLowerCase() === 'yes' ? 'YES' : 'NO'`. No multi-outcome branch.
4. **Status filter:** include positions where `status IN ('open', 'closing')` (not just `'open'`). The FE renders `'closing'` rows in a disabled "Closing…" state so the user has visual confirmation between their tap and SignHandler finishing. Today `IPredictionMarketBetRepository.listOpenPositionsForUser` may filter to `'open'` only — verify in the drizzle impl. If it does, **add a parameter** `listPositionsForUser(userId, statuses: PositionStatus[])` rather than mutating the existing method's contract (chat-side `handlePmState` callers expect open-only).
5. Markets missing from the join (deleted/expired from the latest run) → `marketQuestion: "Market #${marketId.slice(0, 8)}"` so the FE never sees `null`. Log `warn` with `{ positionId, marketId }`.

#### Slice 1b — `getMarketsByIds` repo method

`IPredictionMarketRepository` today only exposes `getMarketsByRun(runId)`. Add:

```ts
getMarketsByIds(ids: string[]): Promise<RawMarket[]>;
```

The drizzle adapter implements it as `SELECT * FROM prediction_markets WHERE market_id IN (...)`. Dedup ids before the query. Empty input → return `[]` without hitting the DB.

> **Convention check**: this is a query on `prediction_markets`, not on a position-scoped table. Keep it on `IPredictionMarketRepository` (alongside `getMarketsByRun`), not on `IPredictionMarketBetRepository`. Document the new method on the relevant `status.md` if the repo doesn't already.

### 2. HTTP route surface (Slice 2)

Update `httpServer.ts` route map (around line 224-226):

```ts
"GET /predictionMarket/positions": (req, res) => this.handlePmListPositions(req, res),
// NEW:
// Param routes already use the regex table at line 290; add three entries.
```

In the param-route table (line 290+):

```ts
[{ method: "GET",  regex: /^\/predictionMarket\/positions\/([0-9a-f-]+)\/previewClose$/ },
   (req, res, _u, id) => this.handlePmPositionPreviewClose(req, res, id)],
[{ method: "POST", regex: /^\/predictionMarket\/positions\/([0-9a-f-]+)\/close$/ },
   (req, res, _u, id) => this.handlePmPositionClose(req, res, id)],
```

#### `handlePmState` — also enrich (line 1463)

`handlePmState` returns `openPositions` to FE debug surfaces. Today it calls `listOpenPositions` (bare `PositionRow[]`). After Slice 1 it must call `listOpenPositionsForDisplay` so the same logical concept ("open positions") has one shape across both endpoints. Otherwise FE consumers of `/state` see opaque ids while consumers of `/positions` see human labels — confusing and a future trap.

```ts
const [setup, intent, positions] = await Promise.all([
  this.predictionMarketBetUseCase.ensureUserSetup(userId).catch(() => null),
  this.predictionMarketBetUseCase.getActiveIntent(userId),
  this.predictionMarketBetUseCase.listOpenPositionsForDisplay(userId), // was listOpenPositions
]);
return this.sendJson(res, 200, {
  setup,
  activeIntent: intent,
  openPositions: positions,
});
```

`listOpenPositions` (raw, no join) stays on the use-case for internal callers (sweepers, reconcilers) that don't need market metadata.

#### `handlePmListPositions` — modify (line 1523)

```ts
private async handlePmListPositions(req, res): Promise<void> {
  const userId = await this.extractUserId(req);
  if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
  if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
  const positions = await this.predictionMarketBetUseCase.listOpenPositionsForDisplay(userId);
  log.info({ reqId, userId, step: "succeeded", count: positions.length }, "pm-list-positions");
  return this.sendJson(res, 200, { positions });   // wrap in object (existing /yield/positions shape parity)
}
```

**Wire shape change**: today `GET /predictionMarket/positions` returns a bare `PositionRow[]`. Change to `{ positions: PositionListItem[] }`. The existing caller is `handlePmState` (which builds the field server-side from `listOpenPositions`, not this endpoint) and one debug-tab path on FE. Grep `GET /predictionMarket/positions` callers before changing; if any consumer reads `body[0]`-style, ship the change behind the FE plan's `useFetch` parser, which already tolerates `{positions}` (see `parseYieldPositions` analog).

#### `handlePmPositionPreviewClose` — new

```ts
private async handlePmPositionPreviewClose(req, res, positionId): Promise<void> {
  const userId = await this.extractUserId(req);
  if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
  if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
  log.info({ reqId, userId, positionId, step: "started" }, "pm-position-preview-close");
  const preview = await this.predictionMarketBetUseCase.previewClose(userId, positionId);
  if (!preview) {
    log.info({ reqId, userId, positionId, step: "succeeded", outcome: "not-open" }, "pm-position-preview-close");
    return this.sendJson(res, 404, { code: "POSITION_NOT_OPEN", error: "That position is no longer open." });
  }
  return this.sendJson(res, 200, preview);
}
```

Response shape matches `previewClose` return: `{ position, bestBidPriceBps, estProceedsUsdcCents, estPnlUsdcCents }`. No new types.

#### Shared error helper — `humanizeCloseError`

`ClosePositionCapability.humanizeError` (closePositionCapability.ts:160-170) and the new HTTP handler need identical error→message mapping. Duplicating the switch is a future drift trap. **Extract** a single helper:

```ts
// be/src/helpers/errors/predictionMarketCloseErrors.ts (new file)

export interface CloseErrorMapping {
  httpStatus: number;
  code: string;
  message: string; // user-facing — used by chat + HTTP responses
}

export function humanizeCloseError(err: unknown): CloseErrorMapping {
  const code = err instanceof Error ? (err.message.split(":")[0] ?? "") : "";
  switch (code) {
    case "POSITION_NOT_FOUND":
      return {
        httpStatus: 404,
        code,
        message: "That position no longer exists.",
      };
    case "POSITION_WRONG_STATUS":
      return {
        httpStatus: 409,
        code,
        message: "This position isn't open for closing right now.",
      };
    case "BET_IN_FLIGHT":
      return {
        httpStatus: 409,
        code,
        message:
          "You already have a bet being placed. Wait for it to settle, then try again.",
      };
    default:
      return {
        httpStatus: 500,
        code: "INTERNAL",
        message: "Couldn't start the close. Please try again.",
      };
  }
}
```

`ClosePositionCapability.humanizeError` becomes a one-liner returning `humanizeCloseError(err).message`. The HTTP handler reads both `httpStatus` and `code` from the same mapping. One source of truth — any future error code added needs one edit.

#### `handlePmPositionClose` — new

```ts
private async handlePmPositionClose(req, res, positionId): Promise<void> {
  const userId = await this.extractUserId(req);
  if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
  if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
  log.info({ reqId, userId, positionId, step: "started" }, "pm-position-close");

  try {
    // Re-quote at close time (same reason as ClosePositionCapability:80 — drift on thin books).
    const preview = await this.predictionMarketBetUseCase.previewClose(userId, positionId);
    if (!preview) {
      return this.sendJson(res, 404, { code: "POSITION_NOT_OPEN", error: "That position is no longer open." });
    }
    const { enqueuedRequestId } = await this.predictionMarketBetUseCase.initiateClose({
      userId,
      positionId,
      clientOrderId: newUuid(),
      refPriceBps: preview.bestBidPriceBps,
    });
    log.info({ reqId, userId, positionId, step: "succeeded", enqueuedRequestId }, "pm-position-close");
    return this.sendJson(res, 200, { enqueuedRequestId });
  } catch (err) {
    log.error({ err, reqId, userId, positionId, step: "failed" }, "pm-position-close");
    const { httpStatus, code, message } = humanizeCloseError(err);
    return this.sendJson(res, httpStatus, { code, error: message });
  }
}
```

`enqueuedRequestId` may be `null` if the bet was created but is waiting on setup (matches the `confirmBetIntent` semantics noted at `IPredictionMarketBetUseCase.ts:101-107`). The FE plan treats `null` as "queued; reopen the mini-app later" — it surfaces a toast and refetches the positions list (the position status is now `closing`, so it'll disappear from the open list once finalized).

### 3. Idempotency / concurrency

`initiateClose` already enforces single-bet-in-flight via `countOpenBetsForUser` and a Redis NX lock keyed on `(betId, slot)` (per `IPredictionMarketBetUseCase.ts:170-181`). Double-tapping the FE Close button while the first request is in flight either:

- Hits the in-flight HTTP request twice (one will land first, the second will see the position already in `closing` and return `POSITION_WRONG_STATUS` → 409). FE must debounce the button anyway (FE plan §3).
- Hits two separate HTTP requests if the first already completed but the FE missed the response: the use-case sees the position already in `closing` and 409s. No duplicate close bet is created.

### 4. Telegram path coexistence

`ClosePositionCapability` keeps emitting the result card with `[Close] [Cancel]` buttons. When the user closes from chat, the position transitions `open → closing`, so the FE positions list endpoint stops returning it on next refetch — the row disappears as expected. No coordination needed beyond the existing state machine.

If a user has an open Telegram preview card and then closes from the mini-app, the chat `confirm_close:<id>` callback will hit `previewClose` → returns `null` → "That position is no longer open." That's the desired UX; same message both surfaces.

## Tasks (shippable slices)

**Slice 1 — payload enrichment + repo method:**

1. Add `getMarketsByIds(ids: string[])` to `IPredictionMarketRepository` + drizzle impl.
2. Verify drizzle impl of `listOpenPositionsForUser` — if it hard-filters to `status='open'`, add `listPositionsForUser(userId, statuses: PositionStatus[])` alongside it (don't change the existing method's contract — internal callers depend on open-only). The use-case calls the new variant with `['open', 'closing']`.
3. Add `PositionListItem` type + `listOpenPositionsForDisplay` method to `IPredictionMarketBetUseCase`; implement the binary YES/NO mapping + missing-market fallback in the use-case.
4. Update `handlePmListPositions` to return `{ positions }` (strictly the new shape — paired FE ships in the same deploy, no dual-shape window).
5. Update `handlePmState` to call `listOpenPositionsForDisplay` so `openPositions` is enriched on both endpoints (one shape for the same concept).
6. Extract `humanizeCloseError` to `be/src/helpers/errors/predictionMarketCloseErrors.ts`; switch `ClosePositionCapability.humanizeError` to delegate.
7. Unit tests: 2 positions on 2 markets → returns both with `marketQuestion`/`outcomeLabel`; position on a missing market → fallback label, warn logged; `closing` status included; `humanizeCloseError` returns the right mapping for each known code.

**Slice 2 — close routes:**

8. Add `handlePmPositionPreviewClose` + `handlePmPositionClose` + the two regex routes. Handler reuses `humanizeCloseError` from Slice 1.
9. Unit tests: 200 happy path; 404 not-open; 409 wrong-status; 409 bet-in-flight; 401 unauth.
10. Integration test: place a paper bet → fill → call `/positions` (assert status=open returned with `marketQuestion`) → call `/positions/:id/previewClose` → call `/positions/:id/close` → call `/positions` again (assert position now returned with status=closing) → drive SignHandler stub → assert position transitions to `closed` and drops from the list.
11. Concurrency test: 5 parallel POST `/close` on same position → exactly one 200, four 409 with `POSITION_WRONG_STATUS`.

**Slice 3 — docs:**

12. Append to `be/src/adapters/implementations/output/predictionMarket/status.md`: positions list now joins market metadata, returns `open|closing` rows, and mini-app close is a peer of the Telegram callback path (both share `previewClose`/`initiateClose`; one state machine).
13. Update `be/src/adapters/implementations/output/capabilities/status.md` if it lists capability surface boundaries — clarify that `ClosePositionCapability` is no longer the only entry point but remains the chat surface, and that error-message mapping moved to `helpers/errors/predictionMarketCloseErrors.ts`.

Each slice is independently revertable. Slice 1 is a payload widening (FE plan defaults missing fields). Slice 2 adds two routes that are dark until FE plan §3 wires the bottom-sheet onClick. Slice 3 is doc-only.

## Risks + mitigations

- **`getMarketsByIds` N+1 / cache stampede.** Mitigation: single `SELECT IN (...)` keyed on the deduped set. Positions are bounded by per-user open count (typically <10); even at 100 it's one query.
- **`prediction_markets` is run-scoped — old positions on markets dropped from the latest run.** `getMarketsByIds` should query without filtering on `is_latest`, so historical markets still resolve. If the row is fully gone (universe pruned), fall back to the truncated-id label.
- **Concurrent close (chat + mini-app).** Already covered by `initiateClose`'s in-flight check; second caller gets 409. Document in status.md so future-you doesn't re-add a guard.
- **`enqueuedRequestId === null` (waiting on setup).** Rare for a _close_ (setup is done at open time), but possible if the user disconnected and re-onboarded between open and close. FE plan handles this by showing a friendly "Close queued; reopen the mini-app shortly" toast.
- **Position payload size growth.** `marketQuestion` adds ~100 bytes per row. Cap at, say, 200 chars at the HTTP boundary if a market has a pathological question string — but Polymarket questions are short; defer until measured.

## Acceptance

- `GET /predictionMarket/positions` returns `{ positions: PositionListItem[] }` with `marketQuestion` + `outcomeLabel` populated for every row, including positions on markets missing from the latest run (fallback applied).
- `GET /predictionMarket/positions/:id/previewClose` returns the same shape as the existing `previewClose` use-case method.
- `POST /predictionMarket/positions/:id/close` returns `{ enqueuedRequestId }` on success; position transitions to `closing` in the DB; chat-side `ClosePositionCapability` of the same `positionId` returns "That position is no longer open."
- Race test: 5 concurrent POST `/close` calls on the same position → exactly one succeeds with `enqueuedRequestId`; the other four return 409 `POSITION_WRONG_STATUS`.
- CI grep gate (`check:no-clob-secrets`) still green — none of the new code reaches Polymarket directly.
- Logging: every new handler emits `started`/`succeeded`/`failed` with `reqId`, `userId`, `positionId`. No raw cred/signature fields surface in logs.

## be/STATUS.md follow-ups (after merge)

- "Prediction-market positions list — 2026-MM-DD" entry at the top: noting the enrichment shape change, the two new routes, and that the chat capability is no longer the sole close entry point.
- Document the new convention: **read endpoints that need cross-aggregate joins put the join in the use-case, not the adapter** (e.g. `listOpenPositionsForDisplay` joins `predictionMarketBetRepository` × `predictionMarketRepository`). The HTTP handler stays thin.
