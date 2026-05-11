# Prediction Markets — Deterministic Detection — Part 3 (Phase 2: Extraction + review queue)

Date: 2026-05-11
Status: plan
Index: `2026-05-11-prediction-markets-deterministic-detection.md`
Prerequisite: Part 2 merged and migrations applied (needs `MarketFact` type, vocabularies, `prediction_market_facts`, `prediction_market_extraction_reviews`).
Unblocks: Part 4 (deterministic clustering needs facts populated).

## Goal

Per-market LLM extraction adapter that emits a `MarketFact`, regex-verifies the result, and writes either to `prediction_market_facts` (when verified) or `prediction_market_extraction_reviews` (when not). Hourly job processes new markets. Admin Telegram chat handles approve/reject. **Shadow only** — no impact on the existing scan pipeline. 3–5 days.

## New port

`be/src/use-cases/interface/predictionMarket/IPredictionMarketExtractor.ts`:

```ts
export interface ExtractorInput {
  market: RawMarket;
  reqId: string;
}

export type ExtractorOutcome =
  | { kind: "verified"; fact: MarketFact }
  | { kind: "review"; proposedFact: MarketFact; regexFailures: Array<{ field: string; reason: string }> }
  | { kind: "failed"; reason: string };

export interface IPredictionMarketExtractor {
  extract(input: ExtractorInput): Promise<ExtractorOutcome>;
}
```

## Adapters

### `openaiPredictionMarketExtractor.ts`

`be/src/adapters/implementations/output/predictionMarket/openaiPredictionMarketExtractor.ts`.

- OpenAI strict-JSON output. Schema mirrors `MarketFact` minus provenance fields (adapter stamps server-side).
- Model: env `PREDICTION_MARKETS_EXTRACTOR_MODEL`, default `gpt-4.1-mini` (cheap, batchable; the regex layer catches its mistakes).
- Concurrency: `pLimit(PREDICTION_MARKETS_EXTRACTOR_CONCURRENCY)` default 8.
- Two-attempt retry on JSON-parse failure, identical to existing classifier/detector pattern.
- Prompt structure:
  - System: "You convert one prediction market into a structured fact. The set of allowed `subject` and `resolution_source` values is fixed — pick from the list or output `OTHER` and explain in `extraction_notes`. Reason about the title and resolution criteria together; the title alone is often ambiguous about window or threshold unit. Do not invent thresholds."
  - User: market title, full `resolutionCriteria`, `endDate`, `category` hint.
  - Append `SUBJECTS` and `RESOLUTION_SOURCES` enums as JSON for the model to pick from.

### `marketFactRegexVerifier.ts`

Pure function, no external calls:

```ts
export function verifyFact(args: {
  market: RawMarket;
  proposed: MarketFact;
}): { ok: true } | { ok: false; failures: Array<{ field: string; reason: string }> };
```

Per-field checks:

| Field | Check |
|---|---|
| `subject` | Must be in `SUBJECTS`. `OTHER` is an automatic failure (forces review). |
| `threshold` (numeric) | A number-shaped substring of title or criteria, allowing thousands separators (`,`), short-suffixes (`k`, `m`, `bn`), currency prefixes (`$`, `USD`). Fail if no match. |
| `threshold` (categorical) | Each member of `thresholdSet` must appear (case-insensitive substring) in title or criteria. |
| `windowEnd` | Within ±24h of `RawMarket.resolutionEpochSec`. Fail if outside. |
| `windowStart` | If non-null and a phrase like "between X and Y" / "during May 2026" appears, must match. Soft warning if mismatched (start is often implicit). |
| `operator` | A keyword from the operator's set must appear. `gte`: `[reach, hit, above, at least, ≥, >=]`; `gt`: `[>, more than, exceed]`; `lte`: `[below, under, at most, ≤, <=]`; etc. Zero matches ⇒ fail. |
| `resolutionSource` | Must be in `RESOLUTION_SOURCES`. If specific (e.g. `COINBASE_PRO_USD`), source name or known alias must appear in criteria. `UMA_PROSE_JUDGMENT` requires "UMA" or "Optimistic Oracle" in criteria; otherwise challenged. |
| `polymarketEventId` | Must equal Gamma's `event_id` for the market when present. |

Any failure ⇒ outcome is `review`.

## `RawMarket` extension

Polymarket's Gamma response carries `event_id` for clustered markets but our provider drops it. Extend:

- `RawMarket.polymarketEventId: string | null` — populated from `events[0].id` when present.
- `polymarketProvider.ts` — populate the field on both `fetchFiltered` and `fetchByIds`.
- `prediction_market_snapshots` table — new nullable column `polymarket_event_id text`. Backfill is best-effort: old rows keep null, which forces them through the LLM path.

## New use-case + job

### `predictionMarketExtractFacts.usecase.ts`

`be/src/use-cases/implementations/predictionMarketExtractFacts.usecase.ts`:

- Input: `RawMarket[]`.
- Splits into already-extracted (skip — `prediction_market_facts` lookup) and not-yet (extract).
- For each not-yet, call `extractor.extract`; route outcomes to facts table or review table.
- Logs `step: 'extract-fact'` with `marketId`, `outcome`, `durationMs`.

### `predictionMarketExtractFactsJob.ts`

`be/src/adapters/implementations/input/jobs/predictionMarketExtractFactsJob.ts`:

- Hourly, redis-locked (mirror `predictionMarketScanJob`).
- Lock key: `pm:extract:lock`.
- Picks markets from the most recent scan that lack a `prediction_market_facts` row.
- Independent of the scan tick — a market is extracted once, regardless of how many times it appears in scans.

## Admin Telegram review surface

### Notification

When a `review` outcome is written, post one message to the configured admin chat (env `PREDICTION_MARKETS_REVIEW_ADMIN_CHAT_ID`):

```
🟡 Extraction needs review
Market: <question>
Proposed: subject=<...> op=<...> threshold=<...> window_end=<...> source=<...>
Failed: threshold (no match in title), resolution_source (alias not present)
[Approve] [Edit] [Reject]
```

Buttons are inline-keyboard callbacks: `pm_review:approve:<reviewId>`, `pm_review:edit:<reviewId>`, `pm_review:reject:<reviewId>`.

### Callback handler

New handler in `be/src/adapters/implementations/input/telegram/predictionMarketReviewHandler.ts` consumes the three callback prefixes:

- `approve` → write proposed fact verbatim to `prediction_market_facts` with `regexVerified=true`; resolve review row.
- `edit` → reply with a text prompt; the next admin message is parsed as a `MarketFact` JSON edit, applied, then approved.
- `reject` → resolve review row with status `rejected`; market is permanently quarantined from the deterministic pipeline (LLM detector path still serves it).

Reuses the existing admin-auth predicate (admin user IDs from `ADMIN_TELEGRAM_USER_IDS` env).

## Repository extensions

`IPredictionMarketFactRepository.ts` — new port:

```ts
export interface IPredictionMarketFactRepository {
  getByMarketId(marketId: string): Promise<MarketFact | null>;
  getByMarketIds(marketIds: string[]): Promise<Map<string, MarketFact>>;
  upsertFact(fact: MarketFact): Promise<void>;
  insertReview(args: {
    reviewId: string;
    marketId: string;
    proposedFact: MarketFact;
    regexFailures: Array<{ field: string; reason: string }>;
    createdAtEpoch: number;
  }): Promise<void>;
  getReview(reviewId: string): Promise<ReviewRow | null>;
  resolveReview(reviewId: string, resolution: ReviewResolution): Promise<void>;
  listPendingReviews(): Promise<ReviewRow[]>;
}
```

Drizzle adapter in `be/src/adapters/implementations/output/sqlDB/repositories/predictionMarketFact.repo.ts`.

## Env additions

```ts
extractorModel: str("PREDICTION_MARKETS_EXTRACTOR_MODEL", "gpt-4.1-mini"),
extractorConcurrency: num("PREDICTION_MARKETS_EXTRACTOR_CONCURRENCY", 8),
extractorPromptVersion: str("PREDICTION_MARKETS_EXTRACTOR_PROMPT_VERSION", "v1"),
extractFactsIntervalMs: num("PREDICTION_MARKETS_EXTRACT_INTERVAL_MS", 60 * 60 * 1000),
reviewAdminChatId: str("PREDICTION_MARKETS_REVIEW_ADMIN_CHAT_ID", ""),
```

If `reviewAdminChatId` is empty, reviews are persisted but no notification is sent (operator can poll the table manually).

## Logging

- New scopes: `predictionMarketExtractor`, `predictionMarketRegexVerifier`, `predictionMarketExtractFactsJob`, `predictionMarketReviewHandler`.
- New step events: `extract-fact-start`, `extract-fact-end`, `review-notify-sent`, `review-resolved`.
- New metadata fields: `eventFamily`, `subject`, `regexVerified`, `outcome` (`'verified'|'review'|'failed'`).

## Shadow-mode comparison script

`scripts/compare-extraction-vs-llm-clusters.ts` — one-shot:

- For each cluster in the last week of `prediction_market_clusters`, look up each member's `MarketFact`.
- Compute `derived_event_family` per member; check whether all members share the same family.
- Emit CSV `(cluster_id, theme, n_members, n_with_fact, distinct_event_families, agree)`.

`agree` is true when every member has a regex-verified fact AND they share an `eventFamily`. The aggregate agreement rate per subject is the gating metric for promoting that subject in Part 7.

## Side-effect / regression checklist

- **No scan-pipeline integration**: this part adds a parallel extraction job. Existing classifier/detector untouched.
- **`RawMarket` shape change**: `polymarketEventId` is optional in the type and nullable in the table. Verify `toClassifierRecord` (or any downstream serializer) ignores unknown fields — current `toClassifierRecord` projects to a fixed shape, so adding a field to `RawMarket` is safe.
- **Drizzle migrations**: one new column on `prediction_market_snapshots`. Verify post-migrate per the journal-`when` caveat.
- **Telegram admin handler**: new callback prefix `pm_review:`. Confirm no existing handler claims this prefix (`grep -rn "pm_review" be/src` — should be empty).

## Done

- [ ] Extractor adapter, regex verifier, use-case, and hourly job all land. No call site in the scan use-case.
- [ ] `RawMarket.polymarketEventId` populated by the provider.
- [ ] Job runs against current universe; ≥80% of cut-over-candidate subjects extract on first pass with `verified` outcome.
- [ ] Admin Telegram chat receives review notifications and the approve/reject buttons mutate `prediction_market_extraction_reviews` correctly.
- [ ] `scripts/compare-extraction-vs-llm-clusters.ts` produces a CSV; cluster-level agreement is recorded as a baseline for Part 4.
- [ ] `STATUS.md` documents the extractor adapter, the review flow, and how to interpret the agreement CSV.

## Hand-off to Part 4

Part 4 reads `prediction_market_facts` to do deterministic clustering. It cannot promote a subject until that subject has ≥95% verified extraction coverage in the universe. The CSV from this part is the measurement.
