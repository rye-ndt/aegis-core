# Prediction Markets — Stages 1 & 2 (Backend)

Date: 2026-05-06
Status: plan

## Scope

Stages 1 (filter universe) and 2 (causal clustering) of the daily prediction-market feature. Stages 3–5 (mispricing, verify, publish bet card) are out of scope here and will land in follow-ups.

End state after this lands:
- A worker job pulls active Polymarket markets every N minutes, applies the filter set, persists a snapshot of the surviving top-100, and persists clusters of size ≥3 produced by an LLM.
- Each completed run sends a brief of the cluster themes to **all active Telegram users** via the existing `bot.api.sendMessage` path, gated by Redis dedupe so users don't get spammed when nothing changed.
- Output is upgradable: every run is a versioned snapshot pointed at by a `is_latest` flag; reads always hit the latest.

## Cadence decision

Brief asks "every 4 hours". The point of frequent polling is that **stage 3 (later)** needs fresh prices to detect mispricing — clusters themselves are stable.

Decision:
- **Stage 1 (fetch + filter)** runs every `PREDICTION_MARKETS_FETCH_INTERVAL_MS` (default **30 min** = `1_800_000`). Cheap — no LLM cost, just Polymarket REST. This is the price-freshness clock that stage 3 will piggyback on.
- **Stage 2 (cluster)** runs only when the universe membership changes meaningfully (defined below). Uses a Redis-cached cluster set keyed by a hash over `sortedMarketIds + resolutionDates`. Hit ⇒ reuse last clustering. Miss ⇒ re-cluster.
- **Telegram brief** publishes only when the *cluster set* differs from the previous published version (compared by stable hash of cluster `theme + sorted(market_ids)`). Re-runs that produce identical clusters are silent.

Net effect: prices refresh every 30 min for stage 3 to consume; LLM bill is bounded; users get 0–few briefs per day, not 48.

Universe-change predicate (stage 2 trigger):
- New universe hash differs from the cached one, OR
- More than `PREDICTION_MARKETS_RECLUSTER_DELTA` markets (default 10) changed between snapshots, OR
- It's been more than `PREDICTION_MARKETS_MAX_RECLUSTER_AGE_MS` (default 24h) since the last clustering — failsafe re-cluster even if hash matches (prompt drift, model upgrades).

## Filter set (stage 1)

User-supplied; we keep all five:
1. Open interest ≥ `$50_000` (configurable: `PREDICTION_MARKETS_MIN_OI_USD`).
2. 7-day volume ≥ `$20_000` (configurable: `PREDICTION_MARKETS_MIN_7D_VOLUME_USD`).
3. Resolution window: `3 ≤ daysToResolution ≤ 60` (configurable: `MIN_DAYS`, `MAX_DAYS`).
4. Binary YES/NO only (drop categorical / multi-outcome).
5. Has non-empty resolution criteria text.
6. Active (`closed = false`, `archived = false`) and undisputed (no UMA dispute flag).
Then: rank by liquidity, take top 100.

Push-back I considered and rejected:
- Lowering OI floor to $25k — would inflate stage-2 input by ~2× and most extra markets fail the 7-day volume cut anyway. Not worth the LLM cost increase.
- Extending the upper window to 90 days — brief explicitly notes long-dated markets are illiquid and stage 3 will find nothing. Agree.

Two filters worth flagging for the user later (not changing now):
- "Binary YES/NO only" drops markets with two outcomes structured as a `Yes/No` pair under one event but exposed as two separate markets in the API. We will treat each leg as binary if its individual outcomes are binary, even if the parent event has multiple legs. The cluster step can re-link them via causal driver.
- Polymarket's `liquidityNum` and `volumeNum` fields are gateway-cached and lag by minutes. Acceptable for this loop.

## Architecture (hexagonal, port boundaries preserved)

### New ports (`be/src/use-cases/interface/`)

```
output/predictionMarket/
  IPredictionMarketProvider.ts        // pull + filter Polymarket
  IPredictionMarketClassifier.ts      // LLM clustering port — provider-agnostic
  IPredictionMarketRepository.ts      // run / market / cluster persistence
input/predictionMarket/
  PredictionMarketTypes.ts            // Market, Cluster, Run, ExpectedRelationship — shared shapes
```

### `IPredictionMarketProvider`

```ts
export interface ProviderFilters {
  minOpenInterestUsd: number;
  minVolume7dUsd: number;
  minDaysToResolution: number;
  maxDaysToResolution: number;
  topN: number;
}

export interface RawMarket {
  marketId: string;             // Polymarket condition_id (canonical)
  slug: string;
  question: string;
  resolutionCriteria: string;   // full rules text
  category: string | null;      // Polymarket-supplied tag, untrusted
  resolutionEpochSec: number;
  yesPrice: number;             // 0..1
  noPrice: number;              // 0..1
  openInterestUsd: number;
  volume7dUsd: number;
  liquidityUsd: number;
  isActive: boolean;
  isDisputed: boolean;
  outcomesCount: number;        // 2 only after filter
  url: string;
}

export interface IPredictionMarketProvider {
  fetchFiltered(filters: ProviderFilters): Promise<RawMarket[]>;
}
```

### `IPredictionMarketClassifier`

```ts
export type ClusterConfidence = "low" | "medium" | "high";

export interface ExpectedRelationship {
  kind: "mutually_exclusive" | "nested" | "term_structure" | "co_moving" | "other";
  description: string;
}

export interface DraftCluster {
  theme: string;
  causalDriver: string;
  marketIds: string[];           // ≥3
  expectedRelationships: ExpectedRelationship[];
  rationale: string;
  confidence: ClusterConfidence;
}

export interface ClassifierInput {
  markets: Array<Pick<
    RawMarket,
    "marketId" | "question" | "resolutionCriteria" | "resolutionEpochSec" | "category"
  >>;
  reqId: string;
}

export interface IPredictionMarketClassifier {
  classify(input: ClassifierInput): Promise<DraftCluster[]>;
}
```

### `IPredictionMarketRepository`

```ts
export interface IPredictionMarketRepository {
  insertRun(run: { runId: string; createdAtEpoch: number; universeHash: string; clusterSetHash: string | null; status: 'fetched' | 'clustered' | 'published' | 'failed' }): Promise<void>;
  setLatestRun(runId: string): Promise<void>;
  getLatestRun(): Promise<RunRow | null>;
  insertMarkets(runId: string, markets: RawMarket[]): Promise<void>;
  insertClusters(runId: string, clusters: DraftCluster[]): Promise<void>;
  updateRunStatus(runId: string, status: RunRow['status'], clusterSetHash?: string): Promise<void>;
  getMarketsByRun(runId: string): Promise<RawMarket[]>;
  getClustersByRun(runId: string): Promise<StoredCluster[]>;
}
```

## Adapter implementations

### `polymarketProvider.ts` (output adapter)

- File: `be/src/adapters/implementations/output/predictionMarket/polymarketProvider.ts`.
- Uses native `fetch` (no SDK). Gamma API base: `https://gamma-api.polymarket.com`.
- Endpoint: `GET /markets?active=true&closed=false&archived=false&limit=500&offset=…&order=liquidity&ascending=false`. Page until exhaustion or `MAX_FETCH_PAGES` (default 4 ⇒ 2000 candidates).
- Normalizes to `RawMarket`. Resolution criteria comes from `description` field (Gamma) — verify on first run; if blank, also check `events[].description`.
- Applies filters in-memory after normalization. Drops markets where `outcomes.length !== 2` or `outcomes` is not `["Yes","No"]` (case-insensitive).
- Disputed: best-signal field is `umaResolutionStatus` / `acceptingOrders`. We treat `acceptingOrders === false` AND `closed === false` as disputed/halted ⇒ drop.
- Sorts by `liquidityNum DESC` and slices to `topN`.
- All env reads via new `helpers/env/predictionMarketEnv.ts` — no inline literals.
- Logging:
  - `log.info({ step: "started", reqId }, "fetch-universe")`
  - `log.debug({ status, url }, "polymarket fetch")` per page
  - `log.info({ step: "succeeded", reqId, fetched, surviving, durationMs }, "fetch-universe")`
  - `log.warn({ status, url }, "polymarket fetch failed")` on non-2xx, with retry (3 attempts, 250ms backoff).

### `openaiPredictionMarketClassifier.ts` (output adapter)

- File: `be/src/adapters/implementations/output/predictionMarket/openaiPredictionMarketClassifier.ts`.
- Uses the existing `OpenAI` SDK (already installed). Model env: `PREDICTION_MARKETS_CLASSIFIER_MODEL`, default `gpt-4o`. Provider-agnostic via the port — to swap to Anthropic Sonnet later, drop in `anthropicPredictionMarketClassifier.ts` and rebind in DI; no other module touched.
- Uses **structured outputs** (`response_format: { type: "json_schema", strict: true }`) with the schema below. Forces:
  - rationale BEFORE `marketIds` in the schema/property order so the model writes reasoning first.
  - `marketIds` `minItems: 3`.
  - confidence enum.
  - Each market_id appears in at most one cluster (validated post-parse; on violation, drop the lower-confidence cluster and log warn).
- Prompt (full text in adapter file):
  - System: define "coherent cluster" as **shared causal driver such that the same event materially affects all resolutions**, NOT topical overlap. Spell out the topical-vs-causal distinction.
  - 3 positive examples (Fed rate path / mid-2026 election multi-leg / specific NFL season prop chain).
  - 3 negative examples ("markets about Trump" — topical not causal; "markets about crypto" — topical; two markets that share keywords but resolve from different sources/dates).
  - Edge-case callouts inside the prompt: mutually-exclusive vs nested vs term-structure (force the LLM to pick one in `expectedRelationships.kind`).
  - **Empty output is acceptable.** Prompt explicitly states "if nothing coherent, return `{ clusters: [] }`".
- Per-market record fed to the model:
  ```json
  { "marketId": "0x…", "question": "…", "resolutionCriteria": "…", "resolutionDate": "2026-…", "categoryHint": "…|null" }
  ```
  **Resolution criteria text is sent in full** — the brief is explicit that this is the single most load-bearing input. We truncate per-market criteria to `PREDICTION_MARKETS_MAX_CRITERIA_CHARS` (default 4000) only as a hard upper-bound; emit `log.warn` if truncation triggers so we know to raise it.
- Token budget: 100 markets × ~4kB ≈ 400kB. Within `gpt-4o` 128k-token context. If we hit limits, batch by category-hint groups and merge outputs (followup; document in status if triggered).
- Cache: keyed on `sha256(sorted(marketIds + resolutionDates) + promptVersion + model)`. TTL = `PREDICTION_MARKETS_CLUSTER_CACHE_TTL_SEC` (default 24h). Cache stores the parsed `DraftCluster[]`.
- Retries: one retry on JSON parse failure with a "your previous output was not valid JSON, retry" follow-up. After that, return `[]` and log `error`.
- Logging:
  - `log.info({ step: "started", reqId, marketCount }, "classify")`
  - `log.debug({ choice: hit ? "hit" : "miss", reqId }, "cluster cache lookup")`
  - `log.info({ step: "succeeded", reqId, clusters: n, durationMs }, "classify")`
  - `log.warn({ reqId, droppedDup: id }, "classify dedup-overlap")` per overlap drop.
  - `log.error({ err, reqId }, "classify failed")`.

### `predictionMarketRepository.ts` (output adapter)

- File: `be/src/adapters/implementations/output/sqlDB/repositories/predictionMarket.repo.ts` (sits with the other repos).
- Drizzle-only — no raw SQL. New schema additions in `schema.ts`:

```ts
export const predictionMarketRuns = pgTable("prediction_market_runs", {
  runId: uuid("run_id").primaryKey(),
  createdAtEpoch: bigint("created_at_epoch", { mode: "number" }).notNull(),
  universeHash: text("universe_hash").notNull(),
  clusterSetHash: text("cluster_set_hash"),
  status: text("status").notNull(),    // 'fetched' | 'clustered' | 'published' | 'failed'
  isLatest: boolean("is_latest").notNull().default(false),
});

export const predictionMarketSnapshots = pgTable("prediction_market_snapshots", {
  runId: uuid("run_id").notNull(),
  marketId: text("market_id").notNull(),
  slug: text("slug").notNull(),
  question: text("question").notNull(),
  resolutionCriteria: text("resolution_criteria").notNull(),
  category: text("category"),
  resolutionEpochSec: bigint("resolution_epoch_sec", { mode: "number" }).notNull(),
  yesPriceBp: integer("yes_price_bp").notNull(),    // 0..10000
  noPriceBp: integer("no_price_bp").notNull(),
  openInterestUsd: bigint("open_interest_usd_cents", { mode: "number" }).notNull(),
  volume7dUsd: bigint("volume_7d_usd_cents", { mode: "number" }).notNull(),
  liquidityUsd: bigint("liquidity_usd_cents", { mode: "number" }).notNull(),
  url: text("url").notNull(),
}, (t) => ({
  pk: unique().on(t.runId, t.marketId),
  byRun: index("pm_snapshots_by_run").on(t.runId),
}));

export const predictionMarketClusters = pgTable("prediction_market_clusters", {
  clusterId: uuid("cluster_id").primaryKey(),
  runId: uuid("run_id").notNull(),
  theme: text("theme").notNull(),
  causalDriver: text("causal_driver").notNull(),
  marketIds: jsonb("market_ids").notNull(),                   // string[]
  expectedRelationships: jsonb("expected_relationships").notNull(),
  rationale: text("rationale").notNull(),
  confidence: text("confidence").notNull(),                   // 'low' | 'medium' | 'high'
}, (t) => ({
  byRun: index("pm_clusters_by_run").on(t.runId),
}));
```

- Money fields stored as **cents** (`bigint`) to avoid float drift — matches `formatTokenAmount` style elsewhere.
- Prices stored as **basis points** (`integer 0..10000`) for the same reason.
- "Upgradable" semantics: `setLatestRun(runId)` is `UPDATE prediction_market_runs SET is_latest = false WHERE is_latest = true; UPDATE … SET is_latest = true WHERE run_id = $1` inside a transaction. Reads call `getLatestRun()`. Old runs are kept (we'll need them for the win-rate eval in stage 5).
- Migration generated via `npm run db:generate && npm run db:migrate` per house rule.

## Use case (`predictionMarketScan.usecase.ts`)

`be/src/use-cases/implementations/predictionMarketScan.usecase.ts`. Orchestrates the pipeline; depends only on the three ports above + a `ITelegramNotifier`-shaped sender (passed in via DI like `yieldReportJob` does) + `Redis` for dedupe.

```ts
class PredictionMarketScanUseCase {
  async runOnce(reqId: string): Promise<RunOutcome> {
    // 1. fetch universe
    const markets = await this.provider.fetchFiltered(filters);
    const universeHash = hashUniverse(markets);

    // 2. decide whether to re-cluster
    const lastRun = await this.repo.getLatestRun();
    const shouldRecluster = !lastRun
      || lastRun.universeHash !== universeHash
      || diffCount(lastRun, markets) > RECLUSTER_DELTA
      || (now - lastRun.createdAtEpoch) > MAX_RECLUSTER_AGE_SEC;

    const runId = newUuid();
    await this.repo.insertRun({ runId, createdAtEpoch: now, universeHash, clusterSetHash: null, status: 'fetched' });
    await this.repo.insertMarkets(runId, markets);

    let clusters: DraftCluster[];
    if (shouldRecluster) {
      clusters = await this.classifier.classify({ markets, reqId });
    } else {
      clusters = await this.repo.getClustersByRun(lastRun!.runId).then(carryForward);
    }
    // medium confidence -> review log table (out of scope here, just log warn)
    // low confidence -> drop
    const published = clusters.filter(c => c.confidence === 'high');

    await this.repo.insertClusters(runId, clusters);
    const clusterSetHash = hashClusterSet(published);
    await this.repo.updateRunStatus(runId, 'clustered', clusterSetHash);
    await this.repo.setLatestRun(runId);

    // 3. broadcast iff cluster set changed
    const lastPublishedHash = lastRun?.clusterSetHash ?? null;
    if (clusterSetHash !== lastPublishedHash && published.length > 0) {
      await this.broadcaster.broadcast(runId, published);
      await this.repo.updateRunStatus(runId, 'published');
    }
    return { runId, fetched: markets.length, clusters: clusters.length, published: published.length, broadcast: clusterSetHash !== lastPublishedHash };
  }
}
```

Step events emitted at each phase: `fetch-start`, `fetch-end`, `recluster-decision`, `classify-start`, `classify-end`, `broadcast-start`, `broadcast-end`. All carry `reqId`.

## Cron job (`predictionMarketScanJob.ts`)

`be/src/adapters/implementations/input/jobs/predictionMarketScanJob.ts`. Mirrors `yieldReportJob` shape:

- `start()` exits early if `!isWorker()` so the http role doesn't double-run.
- `setInterval(this.tick, PREDICTION_MARKETS_FETCH_INTERVAL_MS)`.
- Tick acquires a Redis lock `pm:scan:lock` with `SET NX PX <intervalMs * 0.9>` so only one worker runs the scan at a time across the fleet.
- On error: log + continue (don't crash the worker).
- Wired in `workerCli.ts` next to `yieldReportJob`.

## Broadcaster

New: `be/src/adapters/implementations/output/predictionMarket/predictionMarketBroadcaster.ts` (and matching port `IPredictionMarketBroadcaster`).

- Audience: `telegramSessions.listActiveUserIds()` → `findByUserId(userId)` chatId, same as yield job.
- Per-user concurrency via `pLimit(5)`.
- Message body uses the existing **result-card framework** to keep visual parity. Build an `IntentResult`:
  ```ts
  {
    status: 'success',
    verb: 'prediction_market_brief',
    headline: 'Today\'s prediction-market clusters',
    fields: [
      { label: 'Clusters surfaced', value: String(published.length), emphasis: 'primary' },
      { label: 'Run', value: shortRunId, emphasis: 'muted' },
    ],
    details: published.map(c => ({
      label: c.theme,
      value: `${c.causalDriver} · ${c.marketIds.length} markets`,
    })),
    complexity: 'complex',
    nextActions: [],   // bet buttons land in stage 5
  }
  ```
- Reuse `renderResultCard` and the MarkdownV2 escape pipeline — capabilities never write MarkdownV2 directly (rule #13).
- New `IntentVerb` value `prediction_market_brief` added to the existing union; surface it through the result-card error catalog as a no-op (no error pattern).
- Per-user dedupe: Redis key `pm:broadcast:lastHash:<userId>` set to `clusterSetHash`. If unchanged, skip that user. TTL 7 days. Prevents replaying the same brief if a user reconnects.
- Privacy: chatIds and userIds are loggable; never log message bodies (they contain market questions which are public, but keep logs lean).

## DI wiring (`assistant.di.ts`)

- New singletons: `_predictionMarketProvider`, `_predictionMarketClassifier`, `_predictionMarketRepo`, `_predictionMarketScanUseCase`, `_predictionMarketScanJob`, `_predictionMarketBroadcaster`.
- All gated on Redis presence (broadcaster needs dedupe key store; classifier wants response cache). If Redis is missing, `getPredictionMarketScanJob()` returns `undefined` and logs `warn` once — same pattern as `getYieldReportJob`.
- `PROCESS_ROLE=worker` (and `combined`) only — http role does not start the job.

## Env (`helpers/env/predictionMarketEnv.ts`)

```ts
export const PREDICTION_MARKETS_ENV = {
  enabled: bool("PREDICTION_MARKETS_ENABLED", false),
  fetchIntervalMs: num("PREDICTION_MARKETS_FETCH_INTERVAL_MS", 30 * 60 * 1000),
  gammaApiBase: str("PREDICTION_MARKETS_GAMMA_API", "https://gamma-api.polymarket.com"),
  maxFetchPages: num("PREDICTION_MARKETS_MAX_FETCH_PAGES", 4),
  topN: num("PREDICTION_MARKETS_TOP_N", 100),
  minOpenInterestUsd: num("PREDICTION_MARKETS_MIN_OI_USD", 50_000),
  minVolume7dUsd: num("PREDICTION_MARKETS_MIN_7D_VOLUME_USD", 20_000),
  minDaysToResolution: num("PREDICTION_MARKETS_MIN_DAYS", 3),
  maxDaysToResolution: num("PREDICTION_MARKETS_MAX_DAYS", 60),
  classifierModel: str("PREDICTION_MARKETS_CLASSIFIER_MODEL", "gpt-4o"),
  maxCriteriaChars: num("PREDICTION_MARKETS_MAX_CRITERIA_CHARS", 4000),
  reclusterDelta: num("PREDICTION_MARKETS_RECLUSTER_DELTA", 10),
  maxReclusterAgeMs: num("PREDICTION_MARKETS_MAX_RECLUSTER_AGE_MS", 24 * 60 * 60 * 1000),
  clusterCacheTtlSec: num("PREDICTION_MARKETS_CLUSTER_CACHE_TTL_SEC", 24 * 60 * 60),
  broadcastConcurrency: num("PREDICTION_MARKETS_BROADCAST_CONCURRENCY", 5),
  promptVersion: str("PREDICTION_MARKETS_PROMPT_VERSION", "v1"),
} as const;
```

`enabled = false` by default — first deploy is dark. Operator flips to `true` once a manual run looks sane.

## Held-out evaluation set (deferred but seeded now)

- New script `be/scripts/predictionMarkets/buildEvalSet.ts`: pulls a frozen universe snapshot from a chosen `runId` and writes `tests/predictionMarkets/eval.json` with `{ marketId, question, resolutionCriteria, expectedClusterId | null }`.
- Operator hand-labels 30–50 markets (Fed/macro, crypto, US politics, sports, regional). Not blocking the ship of stages 1–2, but the file lives in-tree so we can run precision/recall on the classifier prompt as it evolves.
- Out of scope for this PR: the actual scoring harness (lands with stage 3 work).

## Logging conventions applied

- One `createLogger('PredictionMarketScan')`, `('polymarketProvider')`, `('predictionMarketClassifier')`, `('predictionMarketBroadcaster')`, `('predictionMarketScanJob')`.
- `step` events at every phase boundary as listed above.
- New metadata field names introduced (document in `capabilities/status.md` after merge): `runId`, `marketCount`, `clusters`, `published`, `universeHash`.
- `reqId = newUuid().slice(0,8)` per scan tick, threaded through every log line.
- `log.error({ err }, "...")` in every catch before swallow/return.

## Side-effect / regression checklist

- New tables only — no existing columns altered. Drizzle migration is purely additive.
- `IntentVerb` union gains `prediction_market_brief`. Need to verify the result-card error catalog (`errorCatalog.md`) doesn't pattern-match the new verb; it shouldn't — the catalog is keyed on error patterns, and a no-op verb has no patterns.
- `workerCli.ts` adds one more `start()` call and SIGTERM `stop()` line. Matches existing job pattern.
- `assistant.di.ts` grows ~80 LOC of additive wiring; no existing singletons touched.
- Telegram fan-out is bounded by `pLimit(5)` and dedupe — won't flood `bot.api`. Worst case (first run, no dedupe state) is one message to every active user, which yield-report already does daily.
- Polymarket API is unauthenticated; if it rate-limits, the per-tick log will show `warn` and the next tick retries — no user-visible failure mode.

## Done definition

- [ ] Drizzle migration generated + applied locally.
- [ ] `PROCESS_ROLE=worker PREDICTION_MARKETS_ENABLED=true npm run dev:worker` produces one full run end-to-end against live Polymarket: row in `prediction_market_runs` with `is_latest = true`, ≥50 rows in `prediction_market_snapshots`, ≥0 rows in `prediction_market_clusters`, log line `step: "succeeded"` for each phase.
- [ ] Re-run within 30 min produces a new `runId` but `is_latest` flips correctly and broadcaster skips users whose `lastHash` matches.
- [ ] `PREDICTION_MARKETS_ENABLED=false` keeps the job idle (no Polymarket calls).
- [ ] One Telegram test send to a single chatId verified by hand before flipping audience to "all".
- [ ] `STATUS.md` updated with the new tables, env block, and new `IntentVerb`. `src/adapters/implementations/output/capabilities/status.md` updated with the prediction-market broadcaster note.
