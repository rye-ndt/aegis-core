# Prediction Markets — Stage 3 (Backend)

Date: 2026-05-06
Status: plan
Builds on: `2026-05-06-prediction-markets-stage1-2.md`

## Scope

Stage 3 of the daily prediction-market feature: detect mispricings inside the clusters produced by stage 2, verify them deterministically, and push the surviving findings to **all** active Telegram users with a Polymarket external-link button per side.

End state after this lands:
- A new use-case runs after every successful stage-2 clustering (or on retrigger) and produces zero or more `findings` per cluster across the four patterns from the brief: logical inconsistency, term-structure anomaly, implied-scenario contradiction, movement divergence.
- Each finding is verified against fresh live prices before publish; verification failures are dropped and logged.
- Surviving findings are persisted in `prediction_market_findings`, then broadcast to every active Telegram user — one message per finding, with two side-buttons that link out to Polymarket.
- Cross-run deduplication is intentionally **not** implemented (per user decision: option a). Each detector run that produces a verified finding pushes it.

## User decisions baked in

| Decision | Choice |
|---|---|
| Cross-run dedup | None — each verified finding is pushed |
| Per-push fan-out | All findings, no top-K cap |
| Editorial / admin-only gate | None — broadcast straight to all users |
| Detector LLM | Same model env as classifier (`gpt-4o` default), swappable port |
| Bet buttons | External Polymarket URL buttons per side; in-app signing deferred to stage 5 |

## Cadence (sequential — no gate)

**Stage 3 runs every tick, for every cluster, immediately after stage 2.** No per-cluster retrigger gate, no detector-state table, no price-hash compare. Each stage-1 tick (default 30 min) drives the full pipeline: fetch → filter → cluster → detect → verify → broadcast.

This is a deliberate choice over event-gated detection:
- Operationally simpler — one cron, one sequence, no hidden skip paths.
- Movement divergence and freshly-opened mispricings get caught on the very next tick.
- Findings broadcast latency is bounded by `PREDICTION_MARKETS_FETCH_INTERVAL_MS`.

Cost implication to be aware of: detector runs ≈ `numClusters × ticksPerDay` LLM calls. With 48 ticks/day × ~15 clusters that is ~720 detector calls/day worst case. Mitigations:
- Per-tick parallelism is bounded by `pLimit(PREDICTION_MARKETS_DETECTOR_CONCURRENCY)` (default 3) so we don't blow the OpenAI rate window.
- The detector adapter keeps a Redis response cache keyed on `sha256(clusterId + sortedMemberPrices(rounded to 50bps) + promptVersion + model)`, TTL `PREDICTION_MARKETS_DETECTOR_CACHE_TTL_SEC` (default 1800s = 30 min, matches one tick). Quiet ticks (no member price drift past the 50-bp rounding bucket) are a cache hit and skip the LLM round-trip — but the verifier still runs against live prices, so freshness is preserved.

Net: pricing-flat clusters cost one HTTP roundtrip (cache hit) and a re-verify; clusters with real movement pay the LLM. No code path that "skips" stage 3 — every cluster is evaluated every tick.

## Architecture

### New ports (`be/src/use-cases/interface/output/predictionMarket/`)

```
IPredictionMarketDetector.ts
IPredictionMarketVerifier.ts
IPredictionMarketFindingBroadcaster.ts   // separate from stage-2 broadcaster — different message shape
```

Repository: extend `IPredictionMarketRepository` (no new file) with finding methods.

### `IPredictionMarketDetector`

```ts
export type PatternType =
  | "logical_inconsistency"
  | "term_structure_anomaly"
  | "implied_contradiction"
  | "movement_divergence"
  | "other";

export interface SideThesis {
  label: string;           // <= 60 chars, plain English
  marketId: string;        // which market in the cluster this side trades
  outcome: "YES" | "NO";
  rationale: string;       // <= 200 chars
}

export interface DraftFinding {
  patternType: PatternType;
  marketsInvolved: string[];          // marketIds, subset of cluster
  currentState: {
    citedOdds: Record<string, number>;     // marketId -> YES price 0..1
    citedMovements?: Record<string, { delta24hBps: number; delta7dBps: number }>;
  };
  whyAnomalous: string;
  sideA: SideThesis;
  sideB: SideThesis;
  confidence: "low" | "medium" | "high";
  rationale: string;        // written before sides per prompt order
}

export interface DetectorInput {
  cluster: StoredCluster;             // includes expectedRelationships
  members: RawMarket[];                // current snapshot rows for this cluster's markets
  reqId: string;
}

export interface IPredictionMarketDetector {
  detect(input: DetectorInput): Promise<DraftFinding[]>;   // empty array is normal
}
```

### `IPredictionMarketVerifier`

Pure deterministic. No LLM.

```ts
export interface VerifiedFinding extends DraftFinding {
  findingId: string;
  verifiedAtEpoch: number;
  liveOdds: Record<string, number>;       // re-pulled, authoritative
  magnitudeBps: number;                   // pattern-specific gap size
  rankScore: number;                      // for ordering
}

export interface VerifierContext {
  reqId: string;
  cluster: StoredCluster;
  drafts: DraftFinding[];
}

export interface IPredictionMarketVerifier {
  verify(ctx: VerifierContext): Promise<VerifiedFinding[]>;
}
```

Verification rules per pattern:

| Pattern | Drop unless |
|---|---|
| `logical_inconsistency` | Inequality still holds against **fresh** odds (re-fetched within `VERIFY_FRESHNESS_MS`, default 60s). Drop if it no longer holds at all. |
| `term_structure_anomaly` | Gap ≥ `MIN_GAP_BPS` (default **100 bps**) on fresh odds. |
| `movement_divergence` | Lagging market still ≥ `MIN_GAP_BPS` away from leader's implied move. |
| `implied_contradiction` | Cited odds match live within `ODDS_DRIFT_TOLERANCE_BPS` (default **50 bps**). No further math check (subjective pattern). |
| Any | Every cited `marketId` exists in the snapshot AND the cluster. Hallucinated ids drop the whole finding. |
| Any | Every involved market has `liquidityUsd ≥ PREDICTION_MARKETS_FINDING_MIN_LIQUIDITY_USD` (default $25k). Untradeable findings drop. |

`magnitudeBps` definition per pattern (used for ranking):
- `logical_inconsistency`: by how much the inequality is violated, in bps.
- `term_structure_anomaly`: |P(narrower) − P(wider)| in bps.
- `movement_divergence`: |Δ24h(leader) − Δ24h(lagger)| in bps.
- `implied_contradiction`: max distance between any pair of cited odds, in bps (proxy).

`rankScore` = `patternWeight × confidenceWeight × min(magnitudeBps / 1000, 1) × log10(minLiquidityUsd)`.
Pattern weights: logical=4, term_structure=3, contradiction=2, movement=2, other=1.
Confidence weights: high=1.0, medium=0.6, low=0.3.

Stage 3 persists all surviving findings sorted by `rankScore DESC`. Broadcaster pushes them in that order.

### Adapter implementations

#### `openaiPredictionMarketDetector.ts`

`be/src/adapters/implementations/output/predictionMarket/openaiPredictionMarketDetector.ts`.

- Same OpenAI client + structured-output pattern as the classifier.
- Model env: `PREDICTION_MARKETS_DETECTOR_MODEL`, default falls back to `PREDICTION_MARKETS_CLASSIFIER_MODEL` (so a single env tunes both).
- Prompt structure (full text in adapter):
  - System: explain the four patterns with one concrete example each, copied near-verbatim from the user's brainstorm.
  - **Explicit permission to return `{ findings: [] }`** with example "most clusters are priced sensibly".
  - Force the model to write `rationale` BEFORE `sideA`/`sideB` (schema property order).
  - Include `expectedRelationships` from stage 2 verbatim — the prompt frames stage 3 as "check whether actual prices match the expectation stage 2 articulated".
  - Edge-case warnings inlined: resolution-criteria differences can mask apparent inconsistencies; volume must be sufficient; movement divergence may be stale.
- Schema strictness: `pattern_type` enum closed to the five values; `markets_involved` `minItems: 2`; `confidence` enum.
- Retry once on JSON parse failure; on second failure return `[]` and log error.
- Logging:
  - `log.info({ step: "started", reqId, clusterId, members: n }, "detect")`
  - `log.info({ step: "succeeded", reqId, clusterId, drafts: n, durationMs }, "detect")`
  - `log.warn({ reqId, clusterId, droppedHallucination: id }, "detect post-parse drop")` when an `id` not in the cluster appears.
  - `log.error({ err, reqId, clusterId }, "detect failed")`.

#### `predictionMarketVerifier.ts`

`be/src/adapters/implementations/output/predictionMarket/predictionMarketVerifier.ts`.

- Depends on `IPredictionMarketProvider` (re-fetches by id list — small batch endpoint or filter on `marketId`).
- Maintains a tiny in-memory cache keyed on `marketId` with TTL `VERIFY_FRESHNESS_MS` so a single verify pass covering 5 markets is one HTTP call, not five.
- For `movement_divergence`: pulls historical snapshot from `prediction_market_snapshots` joined on `runId(t-24h ± window)`. Falls back to provider's `oneDayPriceChange` field if no historical snapshot is yet stored (early days of the system).
- Logging:
  - `log.info({ step: "started", reqId, clusterId, drafts: n }, "verify")`
  - `log.warn({ reqId, findingId, reason: "gap-closed"|"hallucinated-id"|"low-liquidity"|"odds-drift", patternType }, "verify drop")` per drop.
  - `log.info({ step: "succeeded", reqId, clusterId, surviving: n, durationMs }, "verify")`.

#### `predictionMarketFindingBroadcaster.ts`

`be/src/adapters/implementations/output/predictionMarket/predictionMarketFindingBroadcaster.ts`.

- Audience: all active Telegram users via `telegramSessions.listActiveUserIds()` → `findByUserId()`. Same shape as `predictionMarketBroadcaster` from stage 2.
- One Telegram message per finding (no batching). Order: by `rankScore DESC`.
- Per-user concurrency: `pLimit(PREDICTION_MARKETS_BROADCAST_CONCURRENCY)`.
- Render: builds an `IntentResult` with `verb: "prediction_market_finding"` (new value in the `IntentVerb` union):

```ts
{
  status: "success",
  verb: "prediction_market_finding",
  headline: humanizePattern(finding.patternType),  // e.g. "Logical inconsistency spotted"
  fields: [
    { label: "Cluster", value: cluster.theme, emphasis: "primary" },
    { label: "Driver", value: cluster.causalDriver },
    { label: "Gap", value: formatGap(finding.magnitudeBps), emphasis: "primary" },
    { label: "Confidence", value: finding.confidence, emphasis: finding.confidence === "high" ? "primary" : "muted" },
  ],
  details: [
    { label: "What's anomalous", value: finding.whyAnomalous },
    ...finding.marketsInvolved.map(id => ({
      label: marketLookup[id].question,
      value: `YES ${pct(finding.liveOdds[id])}`,
    })),
    { label: `Side A — ${finding.sideA.label}`, value: finding.sideA.rationale },
    { label: `Side B — ${finding.sideB.label}`, value: finding.sideB.rationale },
  ],
  complexity: "complex",
  nextActions: [
    { label: `Bet ${finding.sideA.label}`, kind: "url", payload: polymarketUrl(finding.sideA.marketId, finding.sideA.outcome) },
    { label: `Bet ${finding.sideB.label}`, kind: "url", payload: polymarketUrl(finding.sideB.marketId, finding.sideB.outcome) },
  ],
}
```

- `nextActions[].kind: "url"` is **new** — current values are `"command" | "callback" | "miniApp"`. We extend the `ResultAction` union and teach `resultCard.render.ts` to render `kind: "url"` as a Telegram inline-keyboard URL button (Telegram supports `{ text, url }` directly in `InlineKeyboardButton`). This keeps capabilities from writing MarkdownV2 themselves (rule #13) and lets stage 5 reuse the same surface for Mini-App buttons later.
- Polymarket URL format: `https://polymarket.com/market/<slug>` (slug from the snapshot) with a `?affiliate=…` query string driven by `PREDICTION_MARKETS_POLYMARKET_AFFILIATE` env (empty = no param). Outcome (YES/NO) is informational in the URL hash — Polymarket's market page lets the user pick a side; we can't deep-link to a side because they don't expose that anchor stably. We surface the recommended side in the button label instead.
- Per-user dedupe: keyed on `pm:finding:lastSeen:<userId>:<findingId>` with a long TTL (7 days). Prevents the same finding being re-pushed if a user briefly disconnects mid-broadcast and the worker retries. **NOT** the same as cross-run dedup — every distinct `findingId` is allowed through to every user once.
- No-Markdown fallback (mirrors yield report job): if MarkdownV2 send fails, retry plain text with the same buttons.

### Repository extension

Drizzle schema additions in `schema.ts`:

```ts
export const predictionMarketFindings = pgTable("prediction_market_findings", {
  findingId: uuid("finding_id").primaryKey(),
  runId: uuid("run_id").notNull(),
  clusterId: uuid("cluster_id").notNull(),
  patternType: text("pattern_type").notNull(),
  marketsInvolved: jsonb("markets_involved").notNull(),    // string[]
  currentState: jsonb("current_state").notNull(),
  liveOdds: jsonb("live_odds").notNull(),
  whyAnomalous: text("why_anomalous").notNull(),
  sideA: jsonb("side_a").notNull(),
  sideB: jsonb("side_b").notNull(),
  confidence: text("confidence").notNull(),
  magnitudeBps: integer("magnitude_bps").notNull(),
  rankScore: integer("rank_score").notNull(),              // ×1000 to keep int
  rationale: text("rationale").notNull(),
  createdAtEpoch: bigint("created_at_epoch", { mode: "number" }).notNull(),
  broadcastedAtEpoch: bigint("broadcasted_at_epoch", { mode: "number" }),
}, (t) => ({
  byRun: index("pm_findings_by_run").on(t.runId),
  byCluster: index("pm_findings_by_cluster").on(t.clusterId),
  byCreated: index("pm_findings_by_created").on(t.createdAtEpoch),
}));

```

(No detector-state table — stage 3 is unconditional per tick. Cache-hit logic for the LLM lives in Redis only, since it's an optimization, not a correctness requirement.)

Repo additions:
- `insertFindings(findings: VerifiedFinding[]): Promise<void>`
- `markFindingsBroadcasted(findingIds: string[], epoch: number): Promise<void>`
- `getFindingsByRun(runId: string): Promise<StoredFinding[]>` (for stage 5 / debugging)

## Use case wiring

Extend `predictionMarketScan.usecase.ts`. After stage-2 cluster persistence, stage 3 runs unconditionally:

```ts
// after clusters persisted and run marked 'clustered'
const limit = pLimit(PREDICTION_MARKETS_ENV.detectorConcurrency);
const findingsByCluster = await Promise.all(
  publishedClusters.map(c => limit(() => this.runStage3ForCluster(runId, c, snapshot, reqId))),
);
const allVerified = findingsByCluster.flat().sort((a, b) => b.rankScore - a.rankScore);
if (allVerified.length > 0) {
  await this.repo.insertFindings(allVerified);
  await this.findingBroadcaster.broadcast(allVerified, snapshotByMarketId);
  await this.repo.markFindingsBroadcasted(allVerified.map(f => f.findingId), now);
}
```

`runStage3ForCluster` does:
1. Run detector → drafts (Redis cache may hit if member prices haven't drifted past 50 bp buckets).
2. Run verifier against live odds → verified findings.
3. Return verified findings (or `[]` if none survive).

No skip path: every cluster goes through the detector call (or its cache lookup) on every tick.

## Env (`predictionMarketEnv.ts` — extend, don't fork)

```ts
detectorModel: str("PREDICTION_MARKETS_DETECTOR_MODEL", PREDICTION_MARKETS_ENV.classifierModel),
detectorConcurrency: num("PREDICTION_MARKETS_DETECTOR_CONCURRENCY", 3),
detectorCacheTtlSec: num("PREDICTION_MARKETS_DETECTOR_CACHE_TTL_SEC", 1800),
detectorPriceBucketBps: num("PREDICTION_MARKETS_DETECTOR_PRICE_BUCKET_BPS", 50),
verifyFreshnessMs: num("PREDICTION_MARKETS_VERIFY_FRESHNESS_MS", 60_000),
oddsDriftToleranceBps: num("PREDICTION_MARKETS_ODDS_DRIFT_TOLERANCE_BPS", 50),
minGapBps: num("PREDICTION_MARKETS_MIN_GAP_BPS", 100),
findingMinLiquidityUsd: num("PREDICTION_MARKETS_FINDING_MIN_LIQUIDITY_USD", 25_000),
polymarketAffiliateParam: str("PREDICTION_MARKETS_POLYMARKET_AFFILIATE", ""),
findingsEnabled: bool("PREDICTION_MARKETS_FINDINGS_ENABLED", false),
```

`findingsEnabled = false` default — operator flips after a manual sane-run. Independent of `PREDICTION_MARKETS_ENABLED` so we can run stages 1-2 without triggering stage 3 during initial validation.

## Logging conventions

- New scopes: `predictionMarketDetector`, `predictionMarketVerifier`, `predictionMarketFindingBroadcaster`.
- New step events: `detect-start`, `detect-end`, `verify-start`, `verify-end`, `broadcast-finding-start`, `broadcast-finding-end`.
- New metadata field names (document in `STATUS.md` after merge): `clusterId`, `findingId`, `patternType`, `magnitudeBps`, `rankScore`, `surviving`, `drafts`.
- `log.warn` per drop with explicit `reason` enum so we can post-mortem how many findings die at which gate.

## Side-effect / regression checklist

- New tables only; no existing columns altered.
- `IntentVerb` union gains `prediction_market_finding`. Verify it doesn't pattern-match the result-card error catalog (it shouldn't — no error patterns).
- `ResultAction` union gains `kind: "url"`. **This is a cross-cutting change** — every existing capability that emits `nextActions` keeps working because they all use `kind: "command" | "callback" | "miniApp"` today. The renderer needs a new branch in `resultCard.render.ts`. Audit every `kind:` switch in the FE and BE — the BE renderer is the only one that builds Telegram keyboards from `nextActions`, but search confirms before merge:
  - `grep -rn "kind: \"command\"\|kind: \"callback\"\|kind: \"miniApp\"" be/src fe/privy-auth/src` — every match must either ignore `"url"` (default branch) or explicitly handle it.
- Telegram fan-out: with all-findings-no-cap and ~1–5 findings per detector run, worst case is 5 messages × N users in a few minutes. `pLimit(5)` keeps it bounded; if Telegram rate-limits hit, `botNotifier` already handles 429 with backoff.
- Polymarket re-fetch in verifier shares the existing provider — no new HTTP client. Provider's per-tick rate-guard is unchanged.

## Done definition

- [ ] Drizzle migration generated + applied locally (1 new table: `prediction_market_findings`).
- [ ] Detector returns sane drafts on a hand-picked cluster (pick a Fed-meeting cluster known to have term-structure pricing).
- [ ] Verifier drops a draft when its cited odds drift >50 bps from live (reproduce by stubbing the snapshot).
- [ ] Verifier drops a draft when an involved market is below $25k liquidity.
- [ ] One end-to-end run on staging produces ≥1 verified finding broadcast to a single test chatId. Polymarket URL buttons open the correct market on tap.
- [ ] Re-run within 30 min with unchanged member prices → detector LLM cache hits (Redis), verifier still runs against live odds, no duplicate finding pushed (verifier dedupe via `findingId` UUID per run keeps fan-out clean — same logical finding is republished as a new row each tick because we are intentionally not cross-run deduping).
- [ ] Re-run with simulated price move > 50 bps on one member → detector cache miss, LLM round-trips.
- [ ] `PREDICTION_MARKETS_FINDINGS_ENABLED=false` keeps stage 3 dormant while stages 1-2 keep running.
- [ ] `STATUS.md` updated with the new table, new env block, new `IntentVerb`, and the new `ResultAction.kind: "url"`. `capabilities/status.md` gets the broadcaster note.

## What stage 3 does NOT do (deferred to stage 5)

- No in-app bet handler. Polymarket buttons are external-link only.
- No cross-run finding deduplication (option a — explicit user choice).
- No editorial review gate. (Brief calls for 60-day founder review; we are skipping it per user instruction.)
- No browse-list UX. Findings persist in DB but only the broadcasted ones are surfaced.
- No win-rate eval harness. The eval data path from stage 1-2 is reused; scoring lands with stage 5.
