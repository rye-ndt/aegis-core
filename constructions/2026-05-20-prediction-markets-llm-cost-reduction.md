# Prediction markets — LLM quota reduction plan

**Date:** 2026-05-20
**Owner:** rye
**Status:** proposed

## Motivation

The prediction-market scan pipeline is burning OpenRouter quota. Root-cause
trace (see "Diagnosis" below) shows the cost is dominated by **reasoning
tokens** on two hot-path LLM calls — the Stage-2 classifier and the Stage-3
detector — both running with `reasoningEffort: "medium"` and 12k token budgets
on every scan tick. The 24h/30min response caches are real but miss far more
often than they hit because:

- The classifier cache key is invalidated by any single universe change
  (`hashUniverse` includes every market id + resolution time).
- The detector cache key buckets member YES prices to 50 bps, which on liquid
  Polymarket clusters crosses bucket boundaries on most ticks.

This plan is aligned with the existing memory principle **"markets are data,
not language"** (`memory/feedback_markets_are_data.md`) and with the
deterministic-detection construction series
(`2026-05-11-prediction-markets-deterministic-detection-part1..7.md`). Those
plans already built the deterministic detector and clusterer; this plan
finishes the rollout and adds two cheap stop-gaps that take effect immediately.

## Diagnosis (one-shot trace, for the record)

| Component | File | Cost trigger |
|---|---|---|
| Classifier | `openaiPredictionMarketClassifier.ts:227-241` | `reasoningEffort: medium`, `maxTokens: 12000`. Re-runs whenever ANY market is added/removed (`predictionMarketScan.usecase.ts:142-159` — `reclusterDelta=10`, `maxReclusterAgeMs=24h`). Cache key in `openaiPredictionMarketClassifier.ts:125-137` is over-specific. |
| Detector | `openaiPredictionMarketDetector.ts:269-284` | `reasoningEffort: medium`, `maxTokens: 12000`, **per cluster, per tick**, concurrency 3. Cache TTL 30 min (`detectorCacheTtlSec`) but the 50-bp price bucket (`detectorPriceBucketBps`) invalidates on most ticks for liquid markets. |
| Scan job | `predictionMarketScanJob.ts:60-62` | 30-min tick. Redis NX lock prevents fleet duplication. This part is fine. |
| Extractor | `openaiPredictionMarketExtractor.ts` (Phase 2) | `extractorModel=gpt-5-nano`, hourly, concurrency 8. Negligible. Leave alone. |

Order of magnitude: with ~5–10 published clusters per tick, the detector alone
is making 5–10 reasoning-heavy calls every 30 minutes; the classifier is
making one large reasoning-heavy call most ticks. That is the burn.

## Approach — three phases

Sequenced to ship quick wins first, then commit to the architectural fix.
**The LLM classifier and detector stay in-tree as fallbacks** for novel /
uncovered subjects — they just stop being on the hot path for the bulk of the
universe, and even in the fallback path they run cheaper.

---

## Phase A — quick wins (1 day, no behaviour change)

Goal: cut per-call cost ~5×, raise cache hit rate, without touching control
flow or schemas. Reversible by env flip.

### A1. Drop `reasoningEffort` on classifier and detector to `"low"`

- `openaiPredictionMarketClassifier.ts:239` — change `reasoningEffort:
  "medium"` → `"low"`. Update the comment block above (`:233-237`) to reflect
  the new default and the rationale (quota burn observed 2026-05-20).
- `openaiPredictionMarketDetector.ts:282` — same change. Update the
  multi-paragraph comment at `:276-280` to note that `(16000, high)` is the
  emergency restore knob, and that the new baseline is `(12000, low)`.
- Optionally also drop `maxTokens` to `8000` on both — the comment notes the
  OpenRouter per-request credit cap is ~13k, and at `effort: low` the
  reasoning prefix is small enough that 8k is plenty for the visible JSON.
- Make these two values **configurable via env** so we can flip without a
  redeploy. Add to `predictionMarketEnv.ts`:
  - `classifierReasoningEffort` (default `"low"`, enum `low|medium|high`)
  - `classifierMaxTokens` (default `8000`)
  - `detectorReasoningEffort` (default `"low"`)
  - `detectorMaxTokens` (default `8000`)
  Wire them through the constructor configs (`OpenAIPredictionMarketClassifierConfig`,
  `OpenAIPredictionMarketDetectorConfig`) and DI (`assistant.di.ts`).
- Validate the prompt version bump: dropping reasoning effort can change
  outputs subtly. Bump `PREDICTION_MARKETS_PROMPT_VERSION` from `v3` → `v4`
  to invalidate the existing detector cache (it's part of the cache key —
  see `openaiPredictionMarketDetector.ts:214`). Same for classifier cache
  key — but the classifier key uses `promptVersion` directly (`:136`), so
  the v4 bump covers both.

### A2. Widen detector cache bucket and bump TTL

- `predictionMarketEnv.ts`:
  - `detectorPriceBucketBps`: 50 → **200** (1 cent → 2 cents). For a 4-cent
    finding-threshold pipeline, 2-cent buckets still preserve every
    actionable price movement but quadruple cache hit rate.
  - `detectorCacheTtlSec`: 1800 (30 min) → **3600** (1 hour). The scan tick is
    30 min, so a 1h TTL means we get at least one cache hit between drifts.
- `clusterCacheTtlSec` already 24h — leave.

### A3. Tighten the classifier cache key

- `openaiPredictionMarketClassifier.ts:125-137` — drop
  `resolutionEpochSec` from the cache key. Resolution dates almost never
  shift, and including them means every market expiry causes a cache miss.
  New key: sorted `marketIds` only, plus `promptVersion` + `model`.
  Acceptable risk: in the rare case where a market's resolution is moved on
  Polymarket's side, we'll serve a stale cluster for up to 24h. The
  downstream `reclusterDelta` + `maxReclusterAgeMs` still force re-clusters
  on universe drift.

### A4. Raise `reclusterDelta`

- `predictionMarketEnv.ts:30` — `reclusterDelta`: 10 → **25**. With a
  `topN=100` universe, 10% churn is normal between ticks and currently
  forces a full re-cluster every time.

### A5. Logging + verification

- Log a one-shot banner at scan-job startup showing the new effective values
  (`predictionMarketScanJob.ts:30-59` already does this — extend it with
  `classifierReasoningEffort`, `detectorReasoningEffort`, `priceBucketBps`,
  `detectorCacheTtlSec`).
- Add a `mode: 'hit' | 'miss'` field to the `step: 'succeeded'` log line in
  both adapters (already present). Add a tick-level rollup in
  `predictionMarketScan.usecase.ts` at `step: 'stage3-end'` showing
  `detectorCacheHits` / `detectorCacheMisses` so we can measure the hit-rate
  win in Grafana.
- **Verification gate before merging A:** run the worker locally with
  `PREDICTION_MARKETS_ENABLED=true` for 3 consecutive ticks against prod
  Polymarket data. Confirm:
  - Tick 2/3 show ≥50% detector cache hits.
  - No new `finish_reason=length` warnings (would mean we cut `maxTokens`
    too aggressively).
  - Findings count stays within ±30% of pre-change average (sanity check
    that `effort: low` didn't gut detection quality).

### Files touched in Phase A

- `be/src/helpers/env/predictionMarketEnv.ts`
- `be/src/adapters/implementations/output/predictionMarket/openaiPredictionMarketClassifier.ts`
- `be/src/adapters/implementations/output/predictionMarket/openaiPredictionMarketDetector.ts`
- `be/src/adapters/implementations/input/jobs/predictionMarketScanJob.ts`
- `be/src/adapters/inject/assistant.di.ts`
- `be/src/use-cases/implementations/predictionMarketScan.usecase.ts` (logging only)

### Expected impact

- Per-call cost: ~5× cheaper (`effort: medium` → `low` on reasoning models is
  the dominant token saving).
- Detector cache hit rate: ≈10% → ≈60% (4× bucket + 2× TTL + steady-state
  ticks within TTL).
- Combined per-tick LLM spend: **~10–15× lower** than today.
- Time to ship: half a day code + half a day to watch one full day of ticks.

---

## Phase B — expand deterministic detector cut-over (1 week)

Goal: take the LLM detector off the hot path for the majority of the
universe. The deterministic detector
(`be/src/adapters/implementations/output/predictionMarket/deterministicPredictionMarketDetector.ts`)
already exists from the Part 7 construction. Routing is gated by
`PREDICTION_MARKETS_DETERMINISTIC_SUBJECTS` (default empty → 0% deterministic).
The `pickDetector` invariant
(`predictionMarketScan.usecase.ts:58-69`) already routes per cluster.

### B1. Audit subject coverage

- Run `be/scripts/measure-subject-distribution.ts` against current prod data
  to get the cumulative share of clusters per `SubjectCode`.
- Run `be/scripts/diff-findings-vs-shadow.ts` to confirm the deterministic
  detector and LLM detector agree on the top subjects (shadow mode must be
  on — `PREDICTION_MARKETS_SHADOW_MODE=true` — for the diff to be
  meaningful).
- Acceptance bar per subject: shadow-vs-real agreement ≥ 85% on findings
  (precision: deterministic doesn't fire spurious findings; recall:
  deterministic catches what LLM caught).

### B2. Cut over subjects in stages

- Start with the highest-volume subject that passes the agreement bar.
  Roll over by setting `PREDICTION_MARKETS_DETERMINISTIC_SUBJECTS=<code>`.
- Monitor `step: 'stage3-routing'` log
  (`predictionMarketScan.usecase.ts:303-314`) for one full day to confirm
  routing counts match expectations.
- Compare findings broadcast count (`findingsBroadcast` at `step:
  'tick-end'`) against the prior week's average for that subject. Pause if
  it drops > 30%.
- Repeat for the next subject. Target: ≥ 80% of cluster volume routed
  deterministically within 1 week.

### B3. Drop LLM detector reasoning further for the residual

- Once ≥ 80% of clusters are deterministic, the LLM detector is serving the
  long tail. Drop `detectorMaxTokens` to `4000` and verify no
  `finish_reason=length` errors over a day.

### B4. Status.md updates

- Append to
  `be/src/adapters/implementations/output/status.md` a "Deterministic
  cut-over progress" section listing which `SubjectCode`s are routed
  deterministically and the date each cut over.
- Add to the memory note
  (`memory/feedback_markets_are_data.md`) once cut-over is
  ≥ 80% — note that the principle is now load-bearing in production, not
  aspirational.

### Files touched in Phase B

- Mostly env-only changes. Code changes limited to:
  - `predictionMarketEnv.ts` if we discover any subject-specific knobs need
    surfacing.
  - Status.md updates.

### Expected impact

- LLM detector calls per tick: ~5–10 today → ~1–2 (long tail only) after
  cut-over.
- Combined with Phase A's per-call reduction, **LLM detector spend ~50×
  lower than baseline**.

---

## Phase C — classifier deterministic path (2–3 weeks, lower priority)

Goal: remove the Stage-2 LLM classifier from the hot path. This is the
larger architectural piece and depends on Phase B succeeding.

### C1. Decide: Polymarket `event_id` or extracted-facts clustering?

The memory note explicitly says: "Prefer Polymarket's native `event_id`
grouping over LLM clustering wherever it covers the market." Investigate:

- What share of the topN universe has a non-null `event_id` from Polymarket
  Gamma API? Audit via a one-off script in `be/scripts/` (model after
  `measure-subject-distribution.ts`).
- For markets with `event_id`, group deterministically by `event_id` and
  emit `expectedRelationships: [{ kind: 'mutually_exclusive', ... }]` (the
  default Polymarket event semantic).
- For markets without `event_id`, the existing
  `PredictionMarketDeterministicClusterUseCase` plus extracted facts
  (`predictionMarketExtractFacts.usecase.ts`) is the path.

### C2. Wire `event_id` clustering into the deterministic clusterer

- Extend
  `predictionMarketDeterministicCluster.usecase.ts` with an `event_id`-first
  pass that runs before the subject-based pass. Markets grouped by
  `event_id` exit early and never see the LLM classifier.
- Add a feature flag `PREDICTION_MARKETS_EVENT_ID_CLUSTERING_ENABLED`
  (default `false`) so we can roll it out gradually.

### C3. Reduce LLM classifier to the residual

- After C2 ships and is verified, the LLM classifier serves only markets
  with no `event_id` and no extractable subject. Drop its
  `reasoningEffort` to `"minimal"` and `maxTokens` to `4000`.

### C4. Status.md / memory updates

- Note new convention in
  `be/src/adapters/implementations/output/predictionMarket/status.md` (or
  create one if absent) describing the three-tier cluster routing:
  `event_id` → deterministic-by-subject → LLM fallback.

### Expected impact

- LLM classifier calls per tick: ~1 (most ticks) today → ~0.1 (only when
  residual non-eventid, non-extractable markets churn).
- Combined system spend: **~100× lower than today's baseline**, dominated
  by extractor cost (cheap, nano model, hourly).

---

## Risk register

| Risk | Mitigation |
|---|---|
| `effort: low` drops detection quality | Phase A verification gate; env-flip restore to `medium`; bump prompt version so cache doesn't poison rollback. |
| Widening price bucket masks a fast-moving finding | Acceptable — findings are surfaced for review, not auto-traded for most subjects. Sizing/betting path
gates on its own freshness check (`verifyFreshnessMs=60s`, `oddsDriftToleranceBps=50`). |
| Tightening classifier cache key serves stale clusters when Polymarket moves a resolution date | 24h TTL caps the window. `reclusterDelta`/`maxReclusterAgeMs` still trigger refresh on universe drift. |
| Deterministic cut-over misses an edge case | Shadow mode + diff scripts already exist (`diff-findings-vs-shadow.ts`, `diff-clusters-vs-shadow.ts`). Bar is ≥85% agreement before cut-over. LLM fallback stays available — `pickDetector` falls back when `derivedSubject` is null. |
| Quota burn while Phase A is rolling out | Land A1 (`effort: low`) as a single one-line change first if needed — it's the largest single-knob win. |

## Open questions (raise before starting)

1. Do we have current OpenRouter spend breakdown by model/op? `logCtx`
   includes `op: 'classify' | 'detect' | 'extract'` (see
   `openrouterClient.ts:179`) — confirm these flow to a dashboard before
   Phase A so we can prove the win.
2. Is there an SLA on findings latency? If findings must surface within X
   minutes of a price move, the wider price bucket (A2) could miss the
   inside of that SLA. Default assumption: no hard SLA; findings are
   advisory.
3. Does the existing shadow-mode infrastructure
   (`PREDICTION_MARKETS_SHADOW_MODE`) already write enough data to make
   the B1 audit straightforward, or do we need to backfill?

## Done definition

- Phase A: env knobs surfaced, reasoning effort defaults to low, detector
  cache hit rate ≥ 50% in steady state, findings count within ±30% of
  pre-change baseline over one week.
- Phase B: ≥ 80% of clusters routed deterministically; LLM detector calls
  per tick ≤ 2; shadow diff agreement ≥ 85% on cut-over subjects.
- Phase C: LLM classifier serves < 10% of ticks; primary clustering uses
  `event_id` or extracted facts; documentation updated in status.md +
  memory note.
