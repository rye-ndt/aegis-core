# Prediction Markets — Finding-Card Debug Spoiler

Date: 2026-05-12
Status: plan
Prerequisite: none (operates on existing `VerifiedFinding` data + live CLOB fetch).
Unblocks: post-hoc tradeability analysis paired with paper-bet performance (Part 3 of paper-bets).

## Goal

Append a Telegram MarkdownV2 **spoiler block** to every broadcast finding card carrying full debug context. User taps the spoiler to reveal; everyone else sees the existing card unchanged. The debug block enables eyeballing whether a flagged finding is actually tradeable after spread frictions — without filtering anything out yet.

User-confirmed scope (2026-05-12):
- **Channel:** spoiler block on the user-facing message (`||…||` in MarkdownV2). No separate admin chat.
- **Data:** existing finding/cluster fields **plus** live CLOB top-of-book (bid/ask/depth) per market involved. Skip full ladder beyond `marketsInvolved`. Skip configurable fee model.
- **Gating:** display-only. No suppression, no extra DB write.

## Target output (rendered example, inside `||…||`)

```
✅ subset_violation [HIGH confidence: mag=HIGH, liq=MED, res=HIGH]
finding_id: f_a1b2c3 · cluster: c_btc_may26 · detected 18s ago

Pattern: P(narrower) > P(wider) — VIOLATION
  wider:    BTC dips to $75k    →  38%  (bid 36/ask 40, depth 2.4k)
  narrower: BTC dips to $65k    →  5%   (bid 3/ask 7, depth 800)
  gross gap: 4pp · spread cost: 4pp · NET: 0pp

⚠ Net gap negative after frictions. Not tradeable at current depth.

Resolution: both UMA_GENERIC, May 31 2026, COINBASE close
Subset type: strict (price threshold)
Cluster members (5): [BTC $65k, $75k, $85k, $95k, $100k]
```

Deviations from the user's mock:
- **Fee cost line dropped** — confirmed out of scope. `NET = gross − spread`.
- **"Full ladder: 5 / 38 / 52 / …" line dropped** — would require pulling all cluster snapshots; user picked "+ live orderbook" not "+ full cluster ladder". Cluster-members list still surfaces market titles (cheap, already in `marketById`).
- **Actions row dropped** — actions already render outside the spoiler via the existing `nextActions`. Restating them inside the spoiler is redundant and would confuse the keyboard.
- **`✅` glyph rendered when net ≥ 0; `⚠` when net < 0.** First line reflects tradeability, not just pattern presence.

## Files changed

- `be/src/adapters/implementations/output/predictionMarket/predictionMarketFindingBroadcaster.ts` — pre-fetch orderbook tops in the `broadcast()` pre-render pass; pass a `DebugContext` into `buildResult`; append spoiler to rendered text.
- `be/src/adapters/implementations/output/predictionMarket/findingDebugBlock.ts` *(new)* — pure renderer: takes `{ finding, cluster, marketById, orderbooks, now }`, returns escaped MarkdownV2 spoiler string. Pure function, no side effects, fully unit-testable.
- `be/src/use-cases/interface/predictionMarket/IPredictionMarketFindingBroadcaster.ts` — no change. Public contract unchanged.

## Data plumbing

What we already have on `VerifiedFinding` (no extra fetch):
- `findingId`, `clusterId`, `patternType`, `confidence`, `magnitudeBps`, `marketsInvolved`, `liveOdds[marketId]`, `sideA`/`sideB`, role tags (`widerMarketId` / `narrowerMarketId` / `earlierMarketId` / `laterMarketId`), `detectedAt` (or equivalent timestamp), and the per-axis confidence subscores if persisted (otherwise we render `mag=HIGH` from `confidence` only).

On `StoredCluster`: `theme`, `causalDriver`, `derivedSubject`, `expectedRelationships`, `marketIds`.

On `RawMarket` (via `marketById`): `question`, `resolutionSource`, `endDate`, `slug`.

What we need to fetch fresh per finding:
- For each `marketId` in `finding.marketsInvolved`: `polymarketAdapter.getOrderbookTopOfBook(tokenId)` to get `bestBidPrice`, `bestAskPrice`, `bidSize`, `askSize`. **Requires resolving outcome token id from the marketId via the provider** — same path the paper-bet use-case uses (`provider.getOutcomeTokens(marketId)`). Cache may be cold; fall back to `provider.fetchByIds([marketId])` if miss.

### Derived fields

- **`patternLabel`** mapping (`patternType` → debug-line label):
  - `logical_inconsistency` (nested) → `subset_violation`
  - `logical_inconsistency` (mutually_exclusive) → `mutex_violation`
  - `implied_contradiction` → `implied_contradiction`
  - `term_structure_anomaly` → `term_structure_violation`
  - `movement_divergence` → `movement_divergence`
- **`detectedAgo`** — `now() − finding.detectedAt`, rendered as `Xs / Xm / Xh ago`.
- **`spreadCostBps`** — for the two role-tagged markets the finding is "about":
  - Nested/subset: `(askAsk_narrower − bidBid_wider) − (askMid_narrower − bidMid_wider)` ≈ `(spread_narrower + spread_wider) / 2`. Simplest defensible model: **sum of half-spreads of the two legs** = `(askA − bidA)/2 + (askB − bidB)/2`. Document the choice in the renderer file header so future readers know we're not modeling the exact LP curve.
  - Mutex (3+ legs): `Σ half-spread(leg_i)` across all involved legs.
- **`netGapBps`** = `finding.magnitudeBps − spreadCostBps`.
- **`tradeable`** = `netGapBps > 0`.
- **`resolutionSummary`** — collapsed when all involved markets share `resolutionSource` and `endDate` (most common case); otherwise per-market.

## Renderer — `findingDebugBlock.ts`

```ts
export interface OrderbookSnapshot {
  marketId: string;
  bestBidBps: number;  // 0..10_000; 0 if no bid
  bestAskBps: number;  // 0..10_000; 10_000 if no ask
  bidSizeShares: number;
  askSizeShares: number;
}

export interface RenderDebugBlockArgs {
  finding: VerifiedFinding;
  cluster: StoredCluster;
  marketById: Map<string, RawMarket>;
  orderbooks: Map<string, OrderbookSnapshot>;
  now: Date;
}

/** Returns a MarkdownV2-escaped spoiler block, *including* the surrounding `||`. */
export function renderFindingDebugBlock(args: RenderDebugBlockArgs): string;
```

Pure function. No `createLogger` (renderers stay framework-free); the calling broadcaster logs.

MarkdownV2 escape rules: every literal special char (`_ * [ ] ( ) ~ ` > # + - = | { } . !`) must be backslash-escaped. The function takes free-form market questions and subject codes through an internal `mdv2Escape()` helper. The outer `||` are NOT escaped — they're the spoiler delimiters.

### Layout (pseudocode)

```ts
const lines: string[] = [];
const glyph = tradeable ? "✅" : "⚠";
lines.push(`${glyph} ${patternLabel} [${confidence.toUpperCase()} confidence]`);
lines.push(`finding_id: ${short(findingId)} · cluster: ${short(clusterId)} · detected ${ago}`);
lines.push("");
lines.push(directionLine);   // "Pattern: P(narrower) > P(wider) — VIOLATION"
for (const leg of legs) {
  lines.push(`  ${leg.role}: ${truncate(question, 24)} → ${pct(liveOdds)} (bid ${bid}/ask ${ask}, depth ${depth})`);
}
lines.push(`  gross gap: ${pp(magnitudeBps)} · spread cost: ${pp(spreadCostBps)} · NET: ${pp(netGapBps)}`);
lines.push("");
if (!tradeable) lines.push(`⚠ Net gap negative after frictions. Not tradeable at current depth.`);
lines.push(`Resolution: ${resolutionSummary}`);
if (subsetType) lines.push(`Subset type: ${subsetType}`);
lines.push(`Cluster members (${cluster.marketIds.length}): [${members.join(", ")}]`);
return `||${lines.map(mdv2Escape).join("\n")}||`;
```

Note: `mdv2Escape` is applied per-line after assembly so we control exactly what's escaped (the `→`, `·`, `✅`, `⚠` are non-special and pass through).

## Broadcaster changes

```ts
// In broadcast(), after extracting renderedFindings = … but before sending,
// pre-fetch orderbooks (bounded concurrency).
const orderbookLimit = pLimit(8);
const debugBlockByFinding = new Map<string, string>();
await Promise.all(
  renderedFindings.map(({ finding }) =>
    orderbookLimit(async () => {
      const orderbooks = await this.fetchOrderbooksForFinding(finding);
      debugBlockByFinding.set(
        finding.findingId,
        renderFindingDebugBlock({ finding, cluster: clusterById.get(finding.clusterId)!, marketById, orderbooks, now: new Date() }),
      );
    }),
  ),
);
```

Inside the per-user inner loop, append the spoiler to `rendered.text`:
```ts
const debug = debugBlockByFinding.get(finding.findingId);
const text = debug ? `${rendered.text}\n\n${debug}` : rendered.text;
await this.deps.tgApi.sendMessage(chatId, text, { parse_mode: rendered.parseMode, … });
```

Plain-text fallback path: include a stripped debug block (drop `||` delimiters, no spoiler effect) so the failover message still carries the info.

### Failure handling

- Orderbook fetch failure for any leg → log `warn({ err, findingId, marketId }, "debug-block orderbook fetch failed")`, render the leg with `bid ?/ask ?, depth ?`. Don't drop the whole spoiler.
- Token-id resolution miss → same fallback.
- Renderer throws → log `error`, **send the message without the spoiler** rather than failing the whole broadcast. Spoiler is supplementary.

## Logging

New `createLogger('findingDebugBlock')` not needed — renderer is pure. Broadcaster reuses its existing logger:

```ts
log.debug({ reqId, findingId, orderbookFetches: legs.length }, "debug-block prepared");
log.warn({ err, reqId, findingId, marketId }, "debug-block orderbook fetch failed");
log.error({ err, reqId, findingId }, "debug-block render failed");
```

New metadata field names: `orderbookFetches`, `netGapBps`, `spreadCostBps` (record in `be/STATUS.md`).

## Tests

`be/src/__tests__/findingDebugBlock.test.ts` (new, pure unit):
- Subset/nested finding with positive net → starts with `✅`, no warning line.
- Subset/nested finding with `magnitudeBps < spreadCost` → starts with `⚠`, includes "Not tradeable" line.
- Term-structure pattern → direction line says `P(earlier) > P(later) — VIOLATION`.
- Mutex pattern with 3 legs → all three render in the legs list, spread cost sums all three half-spreads.
- Orderbook missing for one leg → `bid ?/ask ?, depth ?` rendered, no exception.
- Special chars in market question (`.`, `!`, `*`) → properly escaped in MarkdownV2.

`be/src/__tests__/predictionMarketFindingBroadcaster.test.ts` (extend if exists, otherwise new):
- Send mock includes spoiler block.
- Orderbook fetch failure path doesn't fail the send.
- Renderer-throw path falls back to non-spoiler text.

## Performance

Per finding: N orderbook fetches where N = `marketsInvolved.length` (≤ ~5 typically). Bounded outer concurrency=8 across findings. Worst case per broadcast tick: ~40 CLOB requests. Polymarket CLOB tolerates this; we already do similar volume in `predictionMarketScan`.

Tick cost dominated by Telegram fan-out, not orderbook fetch. No measurable user-facing latency added.

## Out of scope

- Persisting `netGapBps` / `spreadCostBps` to the finding row (user picked "Display only" — no schema change).
- Fee-model line.
- Full price ladder of non-involved cluster members.
- Filtering / suppression of `tradeable=false` findings (separate decision, paired with paper-bet data once available).

## Acceptance

- A live broadcast carries a tap-to-reveal spoiler containing the debug block, formatted as above.
- `magnitudeBps` matches the existing card's `Gap` field exactly.
- Bid/ask/depth in the spoiler matches what `polymarketAdapter.getOrderbookTopOfBook` returns at broadcast time (verify with a parallel manual fetch).
- Unit tests pass; existing broadcaster tests untouched and passing.
- A finding with net < 0 displays `⚠` and the "Not tradeable" line; one with net ≥ 0 displays `✅`.
