# Prediction Markets — Deterministic Detection — Part 2 (Phase 1: Schema + primitives + vocab)

Date: 2026-05-11
Status: plan
Index: `2026-05-11-prediction-markets-deterministic-detection.md`
Prerequisite: none in code; recommended after Part 1 for review-cadence reasons.
Unblocks: Part 3 (extractor needs `MarketFact` shape and vocabularies).

## Goal

Lock the canonical `MarketFact` shape, the controlled vocabularies, the resolution-source compatibility matrix, and the relationship primitive functions. **No production behaviour changes** — pure definitions and unit tests. 2–3 days.

## New files

```
be/src/use-cases/interface/predictionMarket/MarketFactTypes.ts
be/src/use-cases/interface/predictionMarket/marketFactVocabularies.ts
be/src/use-cases/interface/predictionMarket/relationshipPrimitives.ts
be/src/use-cases/interface/predictionMarket/__tests__/relationshipPrimitives.test.ts
```

## `MarketFact` shape

```ts
export type Operator = "gte" | "lte" | "gt" | "lt" | "eq" | "in";

export type ThresholdUnit =
  | "USD" | "USD_PCT" | "BPS" | "COUNT" | "BOOL" | "CATEGORY";

export type ResolutionMethod =
  | "any_touch_during_window"
  | "close_at_window_end"
  | "twap_during_window"
  | "official_announcement"
  | "uma_optimistic_oracle"
  | "discrete_outcome_announcement";

export interface MarketFact {
  marketId: string;                     // Polymarket condition_id (FK)
  subject: SubjectCode;                 // controlled vocab
  operator: Operator;
  threshold: number | string | null;    // null when operator='in'
  thresholdSet: string[] | null;        // for operator='in'
  thresholdUnit: ThresholdUnit;
  windowStart: number | null;           // epoch sec
  windowEnd: number;                    // epoch sec; MUST equal Polymarket endDate ±24h
  resolutionSource: ResolutionSourceCode;
  resolutionMethod: ResolutionMethod;
  eventFamily: string;                  // see canonicalEventFamily()
  polymarketEventId: string | null;
  // Provenance
  extractionModel: string;
  extractionPromptVersion: string;
  extractionAtEpoch: number;
  /** False ⇒ row is in review and MUST NOT enter the hot path. */
  regexVerified: boolean;
}

export function canonicalEventFamily(fact: MarketFact): string {
  return `${fact.subject}::${fact.windowStart ?? 0}-${fact.windowEnd}::${fact.resolutionSource}`;
}
```

Two facts with the same `eventFamily` are members of the same cluster (Part 4). The `operator + threshold` then defines their role within the family.

## Vocabularies

`SUBJECTS` — `as const` array. Seed list (top 20 by current market count, measured by `scripts/measure-subject-distribution.ts`):

```
BTC_USD_SPOT, ETH_USD_SPOT, SOL_USD_SPOT,
FED_FUNDS_RATE, CPI_YOY,
US_PRES_2028, US_HOUSE_2026, US_SENATE_2026,
NFL_SUPER_BOWL_LX_WINNER, NBA_FINALS_2026_WINNER,
EPL_TITLE_2025_26, OSCARS_2026_BEST_PICTURE,
WEATHER_NYC_TEMP, BTC_DOMINANCE, ETH_USD_PCT_VS_BTC,
RECESSION_CALL_2026, SP500_LEVEL, NASDAQ_LEVEL,
UEFA_CHAMPIONS_LEAGUE_2025_26, OTHER
```

`OTHER` is the sentinel — any market the LLM can't match goes here AND is forced into the review queue. `OTHER` markets never enter the hot path.

`RESOLUTION_SOURCES`:

```
COINBASE_PRO_USD, COINGECKO_TWAP_1H, KRAKEN_USD,
BLS_OFFICIAL, FOMC_OFFICIAL,
AP_CALL, OFFICIAL_LEAGUE_SCORE,
UMA_PROSE_JUDGMENT, BLOOMBERG_TERMINAL, OTHER
```

`RESOLUTION_COMPATIBILITY` — `Map<ResolutionSourceCode, Set<ResolutionSourceCode>>`. Conservative defaults:

- `COINBASE_PRO_USD ↔ KRAKEN_USD ↔ COINGECKO_TWAP_1H` are pairwise **incompatible**. Different price discovery, different intraday levels — a finding "BTC ≥ 95k by Coinbase" vs "BTC ≥ 95k by Coingecko" is not an arb, it is an oracle disagreement.
- `UMA_PROSE_JUDGMENT` only compatible with itself.
- `OFFICIAL_LEAGUE_SCORE` only compatible with itself.
- Same-source is always compatible.

## Relationship primitives

Pure functions, no side effects. Signature:

```ts
function name(args): { violationBps: number; roles: Record<string, string> } | null;
```

`null` means no violation. `roles` keys are pattern-specific role names; values are `marketId`s.

| Primitive | Args | Violation when | Roles |
|---|---|---|---|
| `subset` | `{ wider, narrower, tolBps }` | `P(narrower) > P(wider) + tol` | `{ wider, narrower }` |
| `partition_exhaustive` | `{ members, tolBps }` | `\|sum(P) − 1\| > tol` | every member by index |
| `partition_nonexhaustive` | `{ members, tolBps }` | `sum(P) > 1 + tol` | every member by index |
| `temporal_nested` | `{ earlier, later, tolBps }` | `P(earlier) > P(later) + tol` | `{ earlier, later }` |
| `complement` | `{ yes, no, tolBps }` | `\|P(yes) + P(no) − 1\| > tol` | `{ yes, no }` |
| `conditional` | `{ aAndB, a, tolBps }` | `P(aAndB) > P(a) + tol` | `{ aAndB, a }` |

## Unit tests (merge bar: 100% line coverage)

`__tests__/relationshipPrimitives.test.ts` covers, at minimum:

- `subset`: $95k > $90k case (narrower > wider), equal case, inverted case, edge-of-tolerance.
- `partition_exhaustive`: 96/3/0 case (consensus, no violation), 130% case (overpriced), 70% case (underpriced).
- `temporal_nested`: "by May 15" 17%, "by May 31" 28% (no violation); flipped (violation).
- All primitives: `tolBps = 0` strict mode and a non-zero tolerance mode.

## Drizzle migrations (definitions only — no callers yet)

```ts
export const predictionMarketFacts = pgTable("prediction_market_facts", {
  marketId: text("market_id").primaryKey(),
  subject: text("subject").notNull(),
  operator: text("operator").notNull(),
  threshold: text("threshold"),
  thresholdSet: jsonb("threshold_set"),
  thresholdUnit: text("threshold_unit").notNull(),
  windowStart: bigint("window_start", { mode: "number" }),
  windowEnd: bigint("window_end", { mode: "number" }).notNull(),
  resolutionSource: text("resolution_source").notNull(),
  resolutionMethod: text("resolution_method").notNull(),
  eventFamily: text("event_family").notNull(),
  polymarketEventId: text("polymarket_event_id"),
  extractionModel: text("extraction_model").notNull(),
  extractionPromptVersion: text("extraction_prompt_version").notNull(),
  extractionAtEpoch: bigint("extraction_at_epoch", { mode: "number" }).notNull(),
  regexVerified: boolean("regex_verified").notNull(),
}, (t) => ({
  byEventFamily: index("pm_facts_by_event_family").on(t.eventFamily),
  bySubject: index("pm_facts_by_subject").on(t.subject),
  byPolymarketEvent: index("pm_facts_by_polymarket_event").on(t.polymarketEventId),
}));

export const predictionMarketExtractionReviews = pgTable("prediction_market_extraction_reviews", {
  reviewId: uuid("review_id").primaryKey(),
  marketId: text("market_id").notNull(),
  proposedFact: jsonb("proposed_fact").notNull(),
  regexFailures: jsonb("regex_failures").notNull(),
  status: text("status").notNull(),         // 'pending' | 'approved' | 'rejected'
  resolution: jsonb("resolution"),
  createdAtEpoch: bigint("created_at_epoch", { mode: "number" }).notNull(),
}, (t) => ({
  byStatus: index("pm_reviews_by_status").on(t.status),
  byMarket: index("pm_reviews_by_market").on(t.marketId),
}));
```

## Side-effect / regression checklist

- **Pure additions**: no existing types or tables touched.
- **No callers yet**: shipping this part adds dead code; first reader is Part 3's extractor.
- **Drizzle journal `when` caveat** (CLAUDE.md): verify the new tables exist via `information_schema.columns` after `db:migrate`. Bump `_journal.json` `when` if the new entry's timestamp is older than the prior max.

## Done

- [ ] `MarketFactTypes.ts`, `relationshipPrimitives.ts`, `marketFactVocabularies.ts` land with no callers.
- [ ] Drizzle migration creates `prediction_market_facts` and `prediction_market_extraction_reviews`. Verified post-migrate via `information_schema.columns`.
- [ ] Unit tests for primitives at 100% line coverage.
- [ ] One-shot script `scripts/measure-subject-distribution.ts` confirms the seed `SUBJECTS` list covers ≥85% of current `topN` markets. (If <85%, expand the list before merge.)
- [ ] `STATUS.md` documents the schema, vocabularies, compatibility matrix, and the "OTHER → review queue" rule.

## Hand-off to Part 3

Part 3 wires the extractor adapter that writes to `prediction_market_facts` (when regex passes) or `prediction_market_extraction_reviews` (when it fails). Part 3 cannot start until the migration in this part is applied in shared envs.
