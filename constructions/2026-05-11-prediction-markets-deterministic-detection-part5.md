# Prediction Markets — Deterministic Detection — Part 5 (Phase 4: Deterministic detection)

Date: 2026-05-11
Status: plan
Index: `2026-05-11-prediction-markets-deterministic-detection.md`
Prerequisite: Part 4 merged + at least one cut-over subject is producing deterministic clusters (with `derivedSubject` set) at the scan tick.
Unblocks: Part 6 (sizing reads `VerifiedFinding`s with role tags from this detector).

## Goal

Pure-code detection via the relationship primitives from Part 2. The LLM detector still serves un-promoted clusters. Shadow mode runs the deterministic detector over **all** verified clusters and writes results to `prediction_market_findings_shadow` for diffing. 1 week.

## New adapter

`be/src/adapters/implementations/output/predictionMarket/deterministicPredictionMarketDetector.ts` implements `IPredictionMarketDetector` (no port shape change).

```ts
async detect({ cluster, members, reqId }: DetectorInput): Promise<DraftFinding[]>;
```

Algorithm:

1. For each member, look up its `MarketFact`. If any member's fact is missing or `regexVerified=false`, return `[]` and log `warn` — the cluster will be served by the LLM path next tick.
2. Read `cluster.expectedRelationships[0].kind` and route:
   - `nested` → for every (wider, narrower) pair from sorted threshold list, call `subset()`. Each non-null result is a `DraftFinding`.
   - `mutually_exclusive` → call `partition_exhaustive()` (or `_nonexhaustive` if the facts say so). One result max.
   - `term_structure` → for every (earlier, later) pair from sorted window list, call `temporal_nested()`.
   - `co_moving` → return `[]`. No primitive yet — co-moving clusters stay LLM-only.
3. Each violation maps to a `DraftFinding`:

| Field | Source |
|---|---|
| `patternType` | `nested` / `mutually_exclusive` → `logical_inconsistency`; `term_structure` → `term_structure_anomaly` |
| `widerMarketId` / `narrowerMarketId` | from `subset()` `roles` |
| `earlierMarketId` / `laterMarketId` | from `temporal_nested()` `roles` |
| `marketsInvolved` | the role marketIds (or all members for partition primitives) |
| `currentState.citedOdds` | live YES prices from `members[]` |
| `rationale` | programmatic string, e.g. `"P(BTC ≥ 100k by 2026-05-31) = 12% but P(BTC ≥ 95k by 2026-05-31) = 8% — the wider event is priced below the narrower."` |
| `whyAnomalous` | one-sentence variant of the same |
| `sideA` / `sideB` | derived deterministically from violation roles. `subset(wider, narrower)`: `sideA = buy YES on wider`, `sideB = buy NO on narrower`. Partition violations: two highest-liquidity members of the violating set. (Real side selection is the LP's job in Part 6; this is a stopgap.) |
| `confidence` | bucketed: `high` if `magnitudeBps > 500` AND every involved market liquidity > $100k; `medium` otherwise. `low` is unused. |

## Verifier reuse

The Part 1 verifier is reused unchanged. Role tags are populated correctly by this detector, and `computeMagnitude` already handles the directional check. The verifier remains the single chokepoint that protects the broadcast from any pipeline.

## Routing in the scan use-case

`predictionMarketScan.usecase.ts` selects the detector per cluster:

```ts
const detectorFor = (cluster: StoredCluster): IPredictionMarketDetector => {
  const subject = cluster.derivedSubject ?? null;
  if (subject && cutOverSubjects.has(subject)) return this.deterministicDetector;
  return this.llmDetector;
};
```

Existing `runStage3ForCluster` is generic over the detector — only the chosen detector instance changes per cluster.

## Shadow mode

When `PREDICTION_MARKETS_SHADOW_MODE=true`, the deterministic detector runs against **every** verified cluster (including ones served by the LLM in production). Output is written to `prediction_market_findings_shadow` and never broadcast.

```ts
export const predictionMarketFindingsShadow = pgTable("prediction_market_findings_shadow", {
  shadowFindingId: uuid("shadow_finding_id").primaryKey(),
  runId: uuid("run_id").notNull(),
  shadowClusterId: uuid("shadow_cluster_id"),    // FK to clusters_shadow when source is shadow
  realClusterId: uuid("real_cluster_id"),        // FK to prediction_market_clusters when source is real
  pipeline: text("pipeline").notNull(),          // 'deterministic'
  patternType: text("pattern_type").notNull(),
  marketsInvolved: jsonb("markets_involved").notNull(),
  liveOdds: jsonb("live_odds").notNull(),
  magnitudeBps: integer("magnitude_bps").notNull(),
  widerMarketId: text("wider_market_id"),
  narrowerMarketId: text("narrower_market_id"),
  earlierMarketId: text("earlier_market_id"),
  laterMarketId: text("later_market_id"),
  rationale: text("rationale").notNull(),
  confidence: text("confidence").notNull(),
  createdAtEpoch: bigint("created_at_epoch", { mode: "number" }).notNull(),
}, (t) => ({ byRun: index("pm_findings_shadow_by_run").on(t.runId) }));
```

## Diff script

`scripts/diff-findings-vs-shadow.ts` joins per `runId`, reporting:

- Findings only the LLM produced (false-negative risk for deterministic — investigate; usually a missing primitive).
- Findings only the deterministic produced (likely true positives the LLM missed).
- Findings both produced where role tags or magnitudes differ materially.

A subject is "shadow-agreement-passing" when, over a 7-day window, every LLM finding for that subject has a deterministic equivalent (same role assignment, magnitude within 100 bps).

## Admin metric route

Extend `be/src/adapters/implementations/input/http/admin.routes.ts` (or its equivalent — search before creating new) with:

```
GET /admin/prediction-markets/shadow-agreement
→ {
    perSubject: [
      { subject: 'BTC_USD_SPOT', llmOnly: 2, shadowOnly: 4, agreed: 38, agreementPct: 95.0 },
      ...
    ],
    overall: { ... },
    windowDays: 7,
  }
```

This metric is the gating input to Part 7's promotion checklist.

## Logging

- New scope: `predictionMarketDeterministicDetector`.
- New step events: `detect-deterministic-start`, `detect-deterministic-end`.
- Per-finding log: `log.info({ step: 'detect-deterministic-end', reqId, clusterId, drafts: n, primitive: 'subset'|'temporal_nested'|'partition_exhaustive' }, 'detect')`.

## Side-effect / regression checklist

- **Verifier shape unchanged**: `VerifiedFinding` has the same fields the broadcaster reads today.
- **LLM detector still wired**: routing is per-cluster, not global. Removing the LLM detector is Part 7's job, not this part's.
- **`prediction_market_findings_shadow` is additive**: no existing tables touched. Verify post-migrate.
- **Concurrency**: `pLimit(detectorConcurrency)` already wraps the detector call in `predictionMarketScan.usecase.ts`. Same limit applies regardless of which detector is chosen — no new throttling needed.

## Done

- [ ] Deterministic detector adapter lands. Selected by the scan for cut-over subjects.
- [ ] Shadow detector runs over all clusters and writes `prediction_market_findings_shadow`.
- [ ] Diff script runs nightly via cron job.
- [ ] `GET /admin/prediction-markets/shadow-agreement` returns per-subject agreement metrics.
- [ ] At least one subject (target: `BTC_USD_SPOT`) reaches ≥95% agreement in staging. Production cutover remains gated on Part 7.
- [ ] `STATUS.md` documents the routing rule and the shadow diff metric.

## Hand-off to Part 6

Part 6's sizer reads `VerifiedFinding`s with role tags. Both the deterministic detector (this part) and the LLM detector (Part 1's prompt update) now produce role tags, so the sizer works against either pipeline.
