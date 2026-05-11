# Prediction Markets — Deterministic Detection — Part 1 (Phase 0: Role tagging)

Date: 2026-05-11
Status: plan
Index: `2026-05-11-prediction-markets-deterministic-detection.md`
Prerequisite: none.
Unblocks: Part 2 (review-cadence convenience), Part 5 (the directional verifier check is reused as-is by the deterministic detector).

## Goal

Eliminate the largest current false-positive class with a surgical change to the existing LLM detector + verifier. No new tables, no architecture moves. One day of work.

The change: the LLM must tag which member of a finding plays the *wider*/*narrower* role (or *earlier*/*later* for term structure). The verifier then computes the gap directionally and drops any finding where the alleged inconsistency is in the right direction.

## Files changed

- `be/src/use-cases/interface/predictionMarket/PredictionMarketTypes.ts` — add optional role tags to `DraftFinding`.
- `be/src/adapters/implementations/output/predictionMarket/openaiPredictionMarketDetector.ts` — extend JSON schema, bump `promptVersion`, add system-prompt addendum.
- `be/src/adapters/implementations/output/predictionMarket/predictionMarketVerifier.ts` — rewrite `computeMagnitude` to consume role tags directly.
- `be/src/helpers/env/predictionMarketEnv.ts` — bump default `promptVersion` to `v3`.
- `scripts/replay-verifier-on-recent-findings.ts` — new one-shot script (lives outside runtime).

## Type additions

`DraftFinding` gains four optional fields. They are optional in the type for back-compat with carry-forward / cached drafts, but the **detector prompt + JSON schema requires them** for the structural patterns.

```ts
/** Pattern-relative role tags. Required at the prompt/schema layer for
 *  nested / term_structure / implied_contradiction; ignored for
 *  movement_divergence. */
widerMarketId?: string;
narrowerMarketId?: string;
earlierMarketId?: string;
laterMarketId?: string;
```

## Detector changes

Bump `promptVersion` env default from `v2` to `v3`. The detector cache key includes `promptVersion`, so the bump invalidates pre-fix cached drafts on first deploy.

Extend the JSON schema:

| Pattern | Required role tags |
|---|---|
| `logical_inconsistency` (nested clusters) | `wider_market_id`, `narrower_market_id` (both must appear in `markets_involved`) |
| `implied_contradiction` (nested clusters) | `wider_market_id`, `narrower_market_id` (same) |
| `term_structure_anomaly` | `earlier_market_id`, `later_market_id` (semantics by `resolutionEpochSec`, not by quoted price) |
| `movement_divergence` | none (symmetric) |
| `logical_inconsistency` / `implied_contradiction` (mutually-exclusive clusters) | none (constraint is on the set sum) |

System-prompt addendum (one paragraph per role pair) spells out semantics with one example each. The model already reasons about wider/narrower implicitly — we are now requiring it to commit.

Post-parse cleanup: drop any finding that fails to populate required role tags. Log `log.warn({ reqId, clusterId, patternType, reason: 'missing-role-tag' }, 'detect post-parse drop')`.

## Verifier changes

Rewrite `computeMagnitude` to consume role tags directly instead of inferring structure from `kind`. The `kind` lookup is still used to choose the **measurement function** (sum-deviation vs pairwise gap), but the **direction** of any pairwise check now comes from role tags, not from sorted-array heuristics.

| Pattern | Cluster kind | Magnitude formula |
|---|---|---|
| `logical_inconsistency`, `implied_contradiction` | `nested` | `gap = P(narrower) − P(wider)` in bps. **Drop if `gap ≤ 0`** with `reason: 'wrong-direction'`. |
| `logical_inconsistency`, `implied_contradiction` | `mutually_exclusive` | `sumDeviationBps(involved)` — unchanged. Role tags ignored. |
| `term_structure_anomaly` | any | `gap = P(earlier) − P(later)` in bps. **Drop if `gap ≤ 0`** with `reason: 'wrong-direction'`. |
| `movement_divergence` | any | unchanged (symmetric delta spread). |

Add explicit `drop("missing-role-tag")` and `drop("wrong-direction")` log lines so post-mortem can quantify how many findings die at each new gate.

## Use-case wiring

`predictionMarketScan.usecase.ts` — no changes. The orchestration is unaffected.

## Backfill / measurement

`scripts/replay-verifier-on-recent-findings.ts` — one-shot, lives outside the runtime:

1. Load the last 7 days of `prediction_market_findings` joined to their snapshot rows.
2. Re-run the new `computeMagnitude` against each draft (using the persisted `currentState.citedOdds` as proxy for what the LLM produced — note that pre-Phase-0 findings won't have role tags, so the script must reconstruct them from the cluster kind heuristically and flag rows where it can't).
3. Write a CSV `(finding_id, old_magnitude_bps, new_magnitude_bps, would_drop, drop_reason)` to `tmp/phase0-replay.csv`.

Expected output: a measurable false-positive rate this single change kills. This number is the baseline against which Parts 4–6 measure their own wins.

## Logging

- New drop reasons logged at `warn`: `missing-role-tag`, `wrong-direction`.
- All other detector / verifier log lines unchanged.

## Side-effect / regression checklist

- **Cache invalidation:** `promptVersion: v2 → v3` invalidates the entire detector Redis cache on first deploy. One round-trip's worth of LLM calls is paid back over ~30 minutes.
- **Carry-forward findings:** `prediction_market_findings` rows from before this deploy do NOT have role tags. They are not re-verified — only future detector outputs are subject to the new check. The replay script is offline-only and does not mutate prod rows.
- **Verifier signature:** unchanged; downstream broadcaster sees the same `VerifiedFinding` shape (the new role tags are optional).
- **Bet pipeline:** unaffected. `findingId`, `marketId`, and outcome assignment all unchanged.

## Done

- [ ] Schema and prompt updated; `promptVersion=v3` shipped via env default.
- [ ] Verifier drops every wrong-direction finding with a `wrong-direction` reason in the log.
- [ ] Verifier drops every finding missing required role tags with a `missing-role-tag` reason in the log.
- [ ] Replay script run on last week of findings; FP-rate delta written to `STATUS.md` for Phase 0.
- [ ] `STATUS.md` for `predictionMarket/` notes the new role-tag fields and the verifier's directional check.
- [ ] At least one staging tick produces a verified finding with populated role tags end-to-end.

## Hand-off to Part 2

Part 2 is independent of Part 1 in code, but reviewing them in order keeps the surface area small. The FP-rate baseline this part produces is the metric Parts 4–6 measure their wins against — without it, "shadow agreement ≥95%" in later parts has no reference point.
