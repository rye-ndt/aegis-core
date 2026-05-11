# Prediction Markets — Deterministic Detection (Index)

Date: 2026-05-11
Status: plan
Builds on: `2026-05-06-prediction-markets-stage1-2.md`, `2026-05-06-prediction-markets-stage3.md`, `2026-05-07-prediction-markets-stage4.md`
Frontend counterpart: `fe/privy-auth/constructions/2026-05-11-prediction-markets-deterministic-detection.md`

## Foundational principle

**Markets are data, not language. The LLM's only job is to turn each market into a structured record once. Everything after that is code.**

The current pipeline calls the LLM on every tick for clustering and detection. After this work the hot path — fetch → cluster → detect → verify → size → broadcast — runs without an LLM call for any cut-over subject. The LLM keeps a single seat: per-market structured extraction, cached forever, regex-verified, batchable.

If a future change needs fuzzy reasoning at runtime, that is a signal the schema is wrong. Fix the schema, do not add a model call.

## User decisions

| Decision | Choice |
|---|---|
| Lang/runtime | All TypeScript in `be/`. LP solver: `glpk.js` (WASM-bound GLPK) primary, `javascript-lp-solver` fallback. |
| Review queue | DB table `prediction_market_extraction_reviews` + admin Telegram chat with approve/reject buttons. No mini-app surface. |
| Shadow comparison | Separate shadow tables (`prediction_market_clusters_shadow`, `prediction_market_findings_shadow`). Dropped after cutover. |
| Per-category cutover | Env var `PREDICTION_MARKETS_DETERMINISTIC_SUBJECTS` (CSV of subject codes). Empty = LLM path everywhere. |
| Bet pipeline | Untouched. `findingId` remains the surfaceable primary key. |

## Parts (in order)

Each part is independently shippable. Each subsequent part lists its prerequisites explicitly.

| # | File | Phase | Goal | Prereq |
|---|---|---|---|---|
| 1 | `…-deterministic-detection-part1.md` | Phase 0 — Role tagging | Verifier drops "wrong-direction" findings; baseline FP-rate measurement. | None. |
| 2 | `…-deterministic-detection-part2.md` | Phase 1 — Schema + primitives + vocab | Lock `MarketFact`, controlled vocabularies, resolution-source compatibility, and pure-function relationship primitives. | None — pure definitions. Recommended after Part 1 for review-cadence reasons. |
| 3 | `…-deterministic-detection-part3.md` | Phase 2 — Extraction + review queue | Per-market LLM extraction adapter, regex verifier, review queue, and the hourly extraction job. Shadow only. | Part 2 (needs `MarketFact`, vocabularies, review-table schema). |
| 4 | `…-deterministic-detection-part4.md` | Phase 3 — Deterministic clustering | Pure-code clustering for cut-over subjects. LLM classifier still serves the rest. Shadow tables for diffing. | Part 3 (needs `prediction_market_facts` populated for cut-over subjects). |
| 5 | `…-deterministic-detection-part5.md` | Phase 4 — Deterministic detection | Pure-code detection via the relationship primitives. LLM detector still serves un-promoted clusters. Shadow tables for diffing. | Part 4 (needs deterministic clusters with `derivedSubject`). |
| 6 | `…-deterministic-detection-part6.md` | Phase 5 — LP sizing | `glpk.js`-based LP that emits exact share quantities and net expected profit. Drops uneconomic findings. | Part 5 (needs verified findings with role tags + `polymarketAdapter` order-book depth). |
| 7 | `…-deterministic-detection-part7.md` | Phases 6–7 — Cutover + hygiene | Per-subject promotion process, LLM detector teardown, replay regression, and ongoing monitoring crons. | Part 6 (needs the full deterministic pipeline shadow-passing). |

## Cross-cutting invariants

These hold from Part 1 onward and are re-asserted per part:

- **No LLM call in the hot detection path for cut-over categories.** Enforced by the routing rule in `predictionMarketScan.usecase.ts`.
- **Deterministic replay.** A replay regression test (Part 7) is the single source of truth for "same price snapshot → same findings".
- **No extraction enters production without regex sign-off.** `prediction_market_facts.regexVerified=true` is a precondition in every read path that feeds the deterministic clusterer.
- **No finding broadcasts without a named relationship primitive and a directional violation.** `VerifiedFinding.magnitudeBps > 0` is enforced in the verifier; the deterministic detector populates role tags or returns nothing.

## What this work does NOT do

- No removal of the LLM extractor — the LLM keeps a permanent, narrow seat for per-market schema extraction.
- No new betting capability. Stage 4 (`predictionMarketBet.usecase.ts`) is consumed but not modified.
- No cross-event semantic clustering ("election ↔ S&P 500"). Out of scope until a `cross_event_correlation` primitive is designed.
- No on-chain execution of arbs by an autonomous agent. Sizing produces a plan; user must still tap a button to bet.
- No automatic vocabulary expansion. New subjects always go through review.
