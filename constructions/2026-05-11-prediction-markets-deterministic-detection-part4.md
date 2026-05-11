# Prediction Markets — Deterministic Detection — Part 4 (Phase 3: Deterministic clustering)

Date: 2026-05-11
Status: plan
Index: `2026-05-11-prediction-markets-deterministic-detection.md`
Prerequisite: Part 3 merged + `prediction_market_facts` populated for at least one cut-over-candidate subject (≥95% verified coverage).
Unblocks: Part 5 (deterministic detection needs deterministic clusters with `derivedSubject`).

## Goal

Pure-code clustering for cut-over subjects. The LLM classifier still serves everything else. Shadow mode runs the deterministic clusterer over the **whole** universe and writes results to a shadow table for diffing. 1 week.

## New use-case

`be/src/use-cases/implementations/predictionMarketDeterministicCluster.usecase.ts`:

```ts
export class PredictionMarketDeterministicClusterUseCase {
  constructor(private readonly factRepo: IPredictionMarketFactRepository) {}

  async cluster(args: {
    runId: string;
    universe: RawMarket[];
    cutOverSubjects: Set<SubjectCode>;
    reqId: string;
  }): Promise<{ deterministic: DraftCluster[]; llmEligible: RawMarket[] }>;
}
```

Algorithm:

1. Lookup `MarketFact` for every market in the universe via `factRepo.getByMarketIds`.
2. Bucket by `polymarketEventId` first (markets with the same event_id are a candidate cluster).
3. Within each candidate, sub-bucket by `canonicalEventFamily(fact)`.
4. Drop sub-buckets whose member resolution sources are not pairwise compatible per `RESOLUTION_COMPATIBILITY`.
5. Sub-buckets with ≥3 members AND whose `subject` is in `cutOverSubjects` become deterministic `DraftCluster`s. Pick `kind` from the structure (table below).
6. Markets not in `cutOverSubjects`, OR whose facts are missing/in-review, pass through as `llmEligible` for the existing classifier path.

## Mapping facts → cluster kind (mechanical)

| Family pattern | `kind` | Drives primitive |
|---|---|---|
| `operator ∈ {gte, lte, gt, lt}` at distinct thresholds, same window | `nested` | `subset` |
| `operator = 'in'` with disjoint, exhaustive `thresholdSet`s covering all categories | `mutually_exclusive` | `partition_exhaustive` |
| `operator = 'in'` with disjoint, non-exhaustive `thresholdSet`s | `mutually_exclusive` | `partition_nonexhaustive` |
| Same `(subject, operator, threshold)` but distinct `windowEnd` | `term_structure` | `temporal_nested` |
| None of the above but same `eventFamily` | `co_moving` | (none yet — co-moving stays LLM-only) |

`expectedRelationships[].description` is generated programmatically (e.g. `"P(BTC ≥ 100k) ≤ P(BTC ≥ 95k)"`). No LLM prose.

## `DraftCluster` extension

Add an optional `derivedSubject?: SubjectCode` to `DraftCluster` / `StoredCluster`. Populated when the cluster comes from this use-case (every member's fact has the same `subject` by construction). Null for LLM-clustered rows.

This field is the routing key Part 5 uses to choose the deterministic detector vs the LLM detector.

## Scan use-case integration

`predictionMarketScan.usecase.ts` gains a branch immediately before the existing classifier call:

```ts
const cutOverSubjects = parseCutOverSubjects(env.deterministicSubjects);
const { deterministic, llmEligible } = await this.deterministicCluster.cluster({
  runId, universe: markets, cutOverSubjects, reqId,
});
const llmClusters = llmEligible.length >= 3
  ? await this.classifier.classify({ markets: llmEligible.map(toClassifierRecord), reqId })
  : [];
clusters = [...deterministic, ...llmClusters];
```

`repo.insertClusters` already accepts `DraftCluster[]` — the only change is making sure it persists `derivedSubject` (new nullable column on `prediction_market_clusters`).

## Shadow mode

When `PREDICTION_MARKETS_SHADOW_MODE=true`, the deterministic clusterer runs over the **entire** universe (not just cut-over subjects) and writes its output to `prediction_market_clusters_shadow`. Shadow rows are never broadcast and never feed Part 5's detector.

```ts
export const predictionMarketClustersShadow = pgTable("prediction_market_clusters_shadow", {
  shadowClusterId: uuid("shadow_cluster_id").primaryKey(),
  runId: uuid("run_id").notNull(),
  pipeline: text("pipeline").notNull(),       // 'deterministic'
  derivedSubject: text("derived_subject"),
  theme: text("theme").notNull(),
  causalDriver: text("causal_driver").notNull(),
  marketIds: jsonb("market_ids").notNull(),
  expectedRelationships: jsonb("expected_relationships").notNull(),
  rationale: text("rationale").notNull(),
  confidence: text("confidence").notNull(),
  createdAtEpoch: bigint("created_at_epoch", { mode: "number" }).notNull(),
}, (t) => ({ byRun: index("pm_clusters_shadow_by_run").on(t.runId) }));
```

## Diff script

`scripts/diff-clusters-vs-shadow.ts` — joins by `runId` and reports:

- LLM clusters with no shadow equivalent (potential coverage gap in deterministic).
- Shadow clusters with no LLM equivalent (deterministic finds something LLM missed — usually true positives).
- Same-`runId` same-`marketIds-set` clusters with different `kind`/`expectedRelationships` (rare; investigate).

Per-subject agreement metric (% of LLM clusters in subject S that have a matching shadow cluster) feeds Part 7's promotion checklist.

## Env additions

```ts
deterministicSubjects: str("PREDICTION_MARKETS_DETERMINISTIC_SUBJECTS", ""), // CSV
shadowMode: bool("PREDICTION_MARKETS_SHADOW_MODE", false),
```

`PREDICTION_MARKETS_DETERMINISTIC_SUBJECTS=""` (default) keeps production 100% on the existing LLM pipeline. Operators control rollout via this env var alone.

## Logging

- New scope: `predictionMarketDeterministicCluster`.
- New step events: `cluster-deterministic-start`, `cluster-deterministic-end`, `shadow-write`.
- Per-cluster log line: `log.info({ step: 'cluster-deterministic-end', reqId, runId, deterministic: n.det, llmEligible: n.llm }, 'cluster')`.

## Side-effect / regression checklist

- **`DraftCluster.derivedSubject`** is additive and nullable. Existing classifier returns clusters without it → carry-forward / dedupe / hash logic in `predictionMarketScan.usecase.ts` continues to work (the field doesn't affect `clusterContentKey` or `hashClusterSet`).
- **Carry-forward stability**: deterministic clusterer must produce the same `eventFamily` for the same fact set (it does — `canonicalEventFamily` is pure). Carry-forward continues to be a no-op when the universe is unchanged.
- **`prediction_market_clusters` schema**: one new nullable column `derived_subject text`. Verify post-migrate.
- **Bet pipeline**: untouched. `findingId` / `clusterId` semantics unchanged.

## Done

- [ ] Deterministic cluster use-case lands. Wired into the scan, only emits real clusters for subjects in `PREDICTION_MARKETS_DETERMINISTIC_SUBJECTS`.
- [ ] Shadow mode runs the deterministic clusterer over the full universe and writes to `prediction_market_clusters_shadow`.
- [ ] Diff script run for one week of ticks; agreement on at least one cut-over subject ≥95% by market-set membership.
- [ ] Resolution-source incompatibility correctly drops at least one historical false-positive cluster (manually identify a Coinbase-vs-Coingecko BTC cluster from the last month, confirm it is now rejected).
- [ ] `STATUS.md` documents the cluster routing rule and the shadow diff metric.

## Hand-off to Part 5

Part 5 reads clusters with `derivedSubject` set and routes them to the deterministic detector. Without this part, every cluster goes to the LLM detector and Part 5 has nothing to do.
