# Prediction Markets — Deterministic Detection — Part 7 (Phases 6–7: Cutover + hygiene)

Date: 2026-05-11
Status: plan
Index: `2026-05-11-prediction-markets-deterministic-detection.md`
Prerequisite: Part 6 merged + at least one subject sustaining ≥95% shadow agreement (Part 5 metric) AND positive sized expected profit (Part 6 metric) for ≥7 consecutive days.
Unblocks: deletion of the LLM detector and classifier (the end-state of this work).

## Goal

Roll the deterministic pipeline live per subject as each one passes the bar. Tear down the LLM detector when the last subject is promoted. Lock in the long-term hygiene that prevents drift.

## Per-subject promotion checklist

Run this once per subject, in order:

- [ ] **≥7 consecutive days of shadow agreement ≥95%** (Part 5's `GET /admin/prediction-markets/shadow-agreement`).
- [ ] **Every shadow-only finding manually reviewed**: confirmed as a true positive (good — LLM missed it) or root-caused as a primitive bug (must fix and re-clock the 7-day window).
- [ ] **Every LLM-only finding manually reviewed**: confirmed as an LLM hallucination (good — deterministic correctly skipped) or root-caused as a missing primitive (must add the primitive and re-clock).
- [ ] **Sized findings show positive expected profit on ≥30% of broadcasts** for the subject (Part 6 metric, queried from `prediction_market_findings.expected_profit_usdc_cents`).
- [ ] Add the subject code to `PREDICTION_MARKETS_DETERMINISTIC_SUBJECTS` in **staging** env. Observe one week. No new shadow-only / LLM-only divergences.
- [ ] Promote in production via env-var update. No deploy.

The CSV log of every promotion (subject, date, agreement %, profit %) lives in `STATUS.md` for the prediction-market feature group.

## LLM detector teardown

Trigger condition: `PREDICTION_MARKETS_DETERMINISTIC_SUBJECTS` covers every active `subject` for ≥30 days.

Steps (single PR):

- [ ] Delete `openaiPredictionMarketDetector.ts`, `IPredictionMarketDetector.ts`, related env keys (`PREDICTION_MARKETS_DETECTOR_*`), and the Redis cache helper.
- [ ] Delete `OpenAIPredictionMarketClassifier` and `IPredictionMarketClassifier` (superseded by the deterministic clusterer).
- [ ] Replace the `IPredictionMarketDetector` port with a direct dependency on `DeterministicPredictionMarketDetector`.
- [ ] Drop `prediction_market_clusters_shadow` and `prediction_market_findings_shadow` (after a final 30-day hold).
- [ ] `STATUS.md` records the teardown date and the final cutover proof.

## Ongoing hygiene

### Crons

- **Hourly**: `scripts/check-extraction-review-queue.ts` reports queue depth. Threshold of 10 pending reviews triggers a Telegram alert to the admin chat.
- **Weekly**: re-run the diff scripts (Part 4 + Part 5) against the prior 7 days. One-line summary per subject (`subject X: agreement 96.3% (Δ −0.4pp)`) posted to the admin chat.

### Replay regression test

`be/src/__tests__/fixtures/prediction-markets-replay/` contains:

- A handful of frozen `(universe, runId, expected_findings)` snapshots covering each promoted subject and each primitive.
- One snapshot per primitive (subset / partition_exhaustive / temporal_nested / etc.).

`be/src/__tests__/predictionMarketsReplay.test.ts` runs each fixture through the deterministic pipeline (clusterer + detector + verifier; sizer mocked) and asserts:

- Same set of `findingId`s (modulo UUIDs — match by `(patternType, sorted marketsInvolved, magnitudeBps within 10bps)`).
- Same role tag assignment per finding.

Any drift fails CI. New primitives are added with a fixture in the same PR.

### PR template enforcement

`CONTRIBUTING.md` (or `.github/pull_request_template.md`) gains a section for prediction-market PRs:

> Adds a new finding pattern? Confirm:
> - [ ] New relationship primitive added in `relationshipPrimitives.ts`.
> - [ ] Unit tests for the primitive at 100% coverage.
> - [ ] Replay fixture added in `__tests__/fixtures/prediction-markets-replay/`.
> - [ ] Extractor schema field added if the primitive needs new metadata.

## Vocabulary expansion process

Subjects in the seed list cover ≥85% of markets at launch (Part 2 measurement). The long tail accumulates in the review queue under `subject=OTHER`. When a single new subject accounts for ≥3% of the queue depth over 4 weeks:

- [ ] Propose the new code in a small PR (`marketFactVocabularies.ts` only).
- [ ] Re-run the extractor over the queue subset → most should now extract cleanly.
- [ ] Subject does NOT auto-promote — it follows the per-subject promotion checklist above.

## Cross-cutting invariants (re-asserted)

- **No LLM call in the hot detection path for cut-over categories.** A unit test (`predictionMarketScan.routing.test.ts`) asserts the routing fn never returns the LLM detector for a subject in `cutOverSubjects`.
- **Deterministic replay.** The replay test is the single source of truth for "same price snapshot → same findings".
- **No extraction enters production without regex sign-off.** `prediction_market_facts.regexVerified=true` precondition enforced at every read path.
- **No finding broadcasts without a named relationship primitive and a directional violation.** Verifier enforces `magnitudeBps > 0`.

## Side-effect / regression checklist

- **Deletion PR**: when the LLM detector is removed, run `grep -rn "OpenAIPredictionMarketDetector\|IPredictionMarketDetector" be/src` — should return zero matches in non-test code.
- **Shadow tables drop**: confirm no read paths depend on them. Any nightly cron / admin route querying them must be updated or deleted in the same PR.
- **Bet pipeline**: untouched. `findingId` continues to be the surfaceable primary key for `PlaceBetCapability` regardless of which pipeline produced the finding.

## Done

- [ ] At least one subject promoted in production (target: `BTC_USD_SPOT`).
- [ ] Replay regression test in CI; fails on drift.
- [ ] Hourly + weekly crons live, posting to admin chat.
- [ ] PR template updated.
- [ ] Per-promotion log line in `STATUS.md` for every subject brought across.

## End state

After every active subject is promoted and the LLM detector is deleted, the prediction-market hot path runs entirely on:

- Cached per-market facts (LLM extracted once, regex-verified).
- Pure-function clustering and detection.
- Pure LP sizing.
- Deterministic verifier.

The LLM is genuinely optional for the hot path. Findings are reproducible from a price snapshot. Unit tests cover the math. Model swaps don't change behaviour. The system is what it should have been from the start.
