# Output adapters — status

## LLM provider → OpenRouter (gpt-5-nano), DeepSeek/OpenAI-chat retired (2026-05-27)

**What:** Every chat/completions adapter now runs on OpenRouter with default
model `openai/gpt-5-nano`. The previously-unwired `openai*` sibling adapters
(which already targeted OpenRouter via `createOpenRouterClient()`) were renamed
to `openrouter*` and wired into `assistant.di.ts`; the DeepSeek sibling adapters
were deleted. Affected adapters: `orchestrator/openrouter.ts`
(`OpenRouterOrchestrator`), `intentParser/openrouter.schemaCompiler.ts`,
`intentInterpreter/openrouter.intentInterpreter.ts`, and the three
`openrouterPredictionMarket{Extractor,Classifier,Detector}.ts`. DI now gates on
`isOpenRouterConfigured()` (was `isDeepseekConfigured()`).

OpenRouter creds + the default model moved to a dedicated
`helpers/env/openrouterEnv.ts` (`OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`,
`OPENROUTER_REFERER`, `OPENROUTER_APP_TITLE`, `OPENROUTER_MODEL`). `openaiEnv.ts`
is now embeddings-only (`OPENAI_API_KEY`). `resultCardEnv` gates on
`OPENROUTER_API_KEY` / defaults to `OPENROUTER_MODEL`.

**Why:** DeepSeek and OpenAI credits were exhausted; OpenRouter is the active
account. The OpenRouter transport already existed (client + dead `openai*`
siblings), so re-activating + renaming it was lower-risk than authoring fresh
adapters. The DeepSeek client/env helpers and their unit test were deleted —
nothing consumed them once the adapters were swapped (the "DeepSeek
structured-output fixup" entry below is now historical).

**Conventions introduced / changed:**

1. **OpenRouter is the only chat provider.** New chat adapters use
   `createOpenRouterClient()` + `withRouterHints(...)` and an `OPENROUTER_MODEL`
   slug (`<provider>/<model>`). Embeddings stay on OpenAI (`embedding/openai.ts`)
   — OpenRouter exposes no embeddings endpoint.
2. **Reasoning effort:** orchestrator/tool-selection runs `low`; strict-JSON
   extraction flows (schema compiler, intent interpreter, PM extractor) run
   `minimal` to leave the full token budget for visible JSON and minimise cost
   on `gpt-5-nano`. PM classifier/detector keep their env-tuned effort
   (`PREDICTION_MARKETS_*_REASONING_EFFORT`, default `low`).
3. **PM model knobs are OpenRouter slugs, passthrough.** `predictionMarketEnv`
   model fields read straight through `str(...)`, so operators can point the
   high-stakes detector at a stronger slug via
   `PREDICTION_MARKETS_DETECTOR_MODEL` and it is honoured verbatim. (The
   DeepSeek detour's `normalizeDeepseekModel`, which rejected provider slugs,
   is gone.)

## DeepSeek structured-output fixup (2026-05-23)

**What:** Reworked the DeepSeek native structured-output paths to use
DeepSeek's documented JSON mode (`response_format: { type: "json_object" }`)
plus local validation, instead of OpenAI/OpenRouter strict-schema transport.
`DeepseekSchemaCompiler` no longer uses `chat.completions.parse()` /
`zodResponseFormat(...)`; the prediction-market classifier / detector /
extractor all validate parsed JSON locally before continuing. The
orchestrator's cache metrics now read DeepSeek's `usage.prompt_cache_hit_tokens`
field, and `applyDeepseekHints()` now returns a copied body instead of mutating
the caller's object in place.

**Why:** The first OpenAI→DeepSeek swap reused OpenRouter/OpenAI conventions
that the native DeepSeek endpoint does not honor consistently. The practical
failure mode was 400s or non-parseable content on every strict-schema path,
which darkened send/swap/yield schema compilation and the prediction-market
LLM pipeline. Local validation restores the existing port contracts without
pretending the transport is stricter than it is.

**Conventions introduced:**

1. **DeepSeek structured output uses JSON mode, not `json_schema`
   transport.** If a DeepSeek adapter needs structured data, send
   `response_format: { type: "json_object" }`, embed the target schema in the
   prompt, and validate the parsed JSON locally (Zod or equivalent). Do not
   use `chat.completions.parse()` or rely on provider-side strict-schema
   enforcement on the native DeepSeek endpoint.
2. **`applyDeepseekHints()` is copy-on-write.** Callers may safely reuse a
   request body literal across invocations; only the returned object may have
   `model` rewritten to `DEEPSEEK_REASONER_MODEL`.
3. **Extractor stays on the default chat model.** The prediction-market fact
   extractor now uses `reasoningEffort: "minimal"` on DeepSeek. Do not route
   that path to the thinking model unless we have fresh evidence that JSON-mode
   reliability stays acceptable there.
4. **DeepSeek prompt-cache telemetry comes from
   `usage.prompt_cache_hit_tokens`.** `prompt_tokens_details.cached_tokens` is
   OpenAI/OpenRouter-shaped compatibility data at best; prefer the native field
   when present.
5. **Prediction-market model envs are DeepSeek-normalized at the env layer.**
   `PREDICTION_MARKETS_{CLASSIFIER,DETECTOR,EXTRACTOR}_MODEL` now default to
   DeepSeek-native ids (`classifier`: `deepseek-v4-flash`; detector falls back
   to classifier; extractor defaults to `deepseek-v4-flash`). If an operator
   leaves behind a stale OpenRouter/OpenAI value such as `openai/gpt-5-nano`
   or `gpt-4.1-mini`, `predictionMarketEnv.ts` coerces it back to the
   DeepSeek default instead of letting the job fail with `model_not_found`.

## DeepSeek provider added (2026-05-23)

**What:** Added a parallel DeepSeek provider alongside the existing
OpenRouter-backed OpenAI adapters. Every chat/completions call site is now
wired through DeepSeek; the embedding adapter still hits OpenAI directly
(DeepSeek does not offer embeddings).

**New files (mirrors of the OpenAI adapters — old files are preserved):**

- `helpers/env/deepseekEnv.ts` — `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`
  (default `https://api.deepseek.com`), `DEEPSEEK_MODEL` (default
  `deepseek-v4-pro`), `DEEPSEEK_REASONER_MODEL` (default `deepseek-reasoner`).
- `helpers/llm/deepseekClient.ts` — `createDeepseekClient()`,
  `isDeepseekConfigured()`, `applyDeepseekHints()` (model-swap hint),
  `callJsonSchemaWithRetry()` mirroring the OpenRouter variant.
- `orchestrator/deepseek.ts`
- `intentParser/deepseek.schemaCompiler.ts`
- `intentInterpreter/deepseek.intentInterpreter.ts`
- `predictionMarket/deepseek{Classifier,Detector,Extractor}.ts`

**Why:** Move chat traffic off OpenRouter for cost / vendor reasons. The
DeepSeek REST API is OpenAI-compatible, so we reuse the `openai` SDK with a
custom `baseURL` — same pattern as the OpenRouter client. We keep the old
adapters in tree (per hexagonal: swap implementations, not interfaces) so a
single DI flip can roll back if DeepSeek regresses.

**Conventions introduced (do NOT break):**

1. **OpenRouter `provider` / `reasoning` hints are NOT valid on DeepSeek
   native API.** `withRouterHints` is OpenRouter-only. The DeepSeek client
   exposes `applyDeepseekHints` instead, which may rewrite `model` on the
   returned copy but NEVER attaches `provider` / `reasoning` fields.
2. **`reasoningEffort: "high"` maps to model selection on DeepSeek.** When a
   caller asks for high effort, `applyDeepseekHints` upgrades `model` to
   `DEEPSEEK_REASONER_MODEL`. Lower values are no-ops on the default chat
   model. Call sites that previously passed `"medium"` should pass either
   `"minimal"` (cheaper, default chat) or `"high"` (reasoner) — there is no
   intermediate gear on DeepSeek native.
3. **`DEEPSEEK_MODEL` is a bare model id**, not a `<provider>/<model>` slug.
   This is the opposite of `OPENAI_MODEL` (OpenRouter slug).
4. **Embedding stays on OpenAI** (`OPENAI_API_KEY` against `api.openai.com`).
   DeepSeek has no embeddings endpoint; do NOT route Pinecone tool-index
   queries through DeepSeek.
5. **The shared `openaiLimiter` (p-limit, env `OPENAI_CONCURRENCY`) gates
   BOTH providers.** Concurrency is a shared resource for outbound LLM
   traffic; do not introduce a parallel `deepseekLimiter`.

**DI swaps (in `adapters/inject/assistant.di.ts`):**

`OpenAIOrchestrator` → `DeepseekOrchestrator`, `OpenAISchemaCompiler` →
`DeepseekSchemaCompiler`, `OpenAIIntentInterpreter` →
`DeepseekIntentInterpreter`, and the three prediction-market adapters
likewise. `isOpenRouterConfigured()` gates → `isDeepseekConfigured()`.
`resultCardEnv.ts` reads `DEEPSEEK_API_KEY` for its `available` flag.

**Prediction-market env knobs:** `PREDICTION_MARKETS_*_MODEL`,
`_REASONING_EFFORT`, `_MAX_TOKENS` still drive the DeepSeek adapters since the
type contract (`ReasoningEffort`) is identical between the two LLM clients.
Model envs are normalized through `predictionMarketEnv.ts` so legacy
OpenRouter/OpenAI model ids don't break DeepSeek-native callers.

## LLM provider split (2026-05-14 OpenRouter migration)

Two-client architecture for the LLM family:

- **Embedding adapter** (`embedding/openai.ts`) — keeps `new OpenAI({ apiKey })`
  authenticated with `OPENAI_API_KEY` against `api.openai.com`. OpenRouter does
  not serve embeddings, and the deprecated tool semantic-search path is the
  only embedding consumer.
- **All chat/completions adapters** — use `createOpenRouterClient()` from
  `helpers/llm/openrouterClient.ts`. Direct `new OpenAI({ apiKey })` is
  forbidden for chat callers; centralising the factory means `baseURL`,
  analytics headers, and routing hints are configured once.

### Affected chat adapters

- `orchestrator/openai.ts` (function-tool dispatch)
- `intentInterpreter/openai.intentInterpreter.ts` (result-card notes)
- `intentParser/openai.schemaCompiler.ts` (`chat.completions.parse` +
  `chat.completions.create` for question generation)
- `predictionMarket/openaiPredictionMarketClassifier.ts`
- `predictionMarket/openaiPredictionMarketDetector.ts`
- `predictionMarket/openaiPredictionMarketExtractor.ts`

### Conventions to preserve

1. **No inline `new OpenAI(...)` in chat code.** Call `createOpenRouterClient()`.
2. **Constructor signatures** for the six chat adapters no longer accept an
   `apiKey` argument. Auth comes from `OPENROUTER_API_KEY` via the factory.
3. **Model slug is the OpenRouter `<provider>/<model>` form.** The default
   `OPENAI_MODEL` is `openai/gpt-5-mini`. The exported symbol name
   `OPENAI_MODEL` is preserved for import-site stability; its semantics are
   now "chat-model slug for OpenRouter", not "bare OpenAI model id".
4. **Strict structured outputs.** Every request that uses `tools` or a strict
   `response_format` (`zodResponseFormat` / `{ type: "json_schema", ... }`)
   must attach `OPENROUTER_REQUIRE_PARAMETERS` (re-exported from
   `helpers/llm/openrouterClient.ts`) via `Object.assign` AFTER the request
   literal is built. Do **not** spread it into the literal with `as any` —
   that collapses the OpenAI SDK's parse-shape inference and breaks the
   typed `response.choices[0].message.parsed` field downstream.
5. **DI gating.** Chat adapters in `assistant.di.ts` are gated on
   `OPENROUTER_API_KEY` (not `OPENAI_API_KEY`). The embedding service in the
   same file remains gated on `OPENAI_API_KEY`.
6. **Result-card env.** `resultCardEnv.apiKey` now reads
   `OPENROUTER_API_KEY` (chat consumer); it is no longer tied to the
   embedding key.

### Why centralise the factory

CLAUDE.md "no hardcoded values": `baseURL`, `HTTP-Referer`, and `X-Title`
must not be inlined into every adapter. A single factory keeps provider
switching to a one-file change and prevents drift between adapters (e.g. one
forgetting the `provider: { require_parameters: true }` routing hint).

### Reasoning-model `max_tokens` note

`intentInterpreter` raised its `max_tokens` cap from 80 → 300. Reasoning-
capable OpenRouter models (`openai/gpt-5-mini` and successors) silently
consume tokens for hidden chain-of-thought; a tight cap produces empty
user-visible output. `temperature` is left in place — OpenRouter ignores it
for models that don't support it.

## AA bundler proxy (2026-05-15)

New adapter `aa/pimlicoBundlerProxy.ts` forwards ERC-4337 JSON-RPC traffic
from the FE to pimlico server-side. Wired to `POST /aa/bundler/:chainId` in
`httpServer.ts` (Privy-token gated, 256 KB body cap, 15 s timeout).

### Why a server-side proxy

`eth_sendUserOperation` from Telegram Desktop's macOS WKWebView fails with
`TypeError: Load failed` for bodies ≳8 KB. The FE has no recoverable signal,
so the BE proxies the call. Side benefits: the pimlico API key leaves the
FE bundle, no CORS preflight on the bundler path, and the URL/key can rotate
without a new FE build.

### Conventions introduced

- **`/aa/*` route prefix** is reserved for AA-stack infrastructure proxies.
  Future paymaster/alt-bundler proxies belong here, not under feature paths.
- **`IBundlerProxy` port** in
  `use-cases/interface/output/aa/bundlerProxy.interface.ts`. Input adapters
  (HTTP server) depend on the interface, never the concrete
  `PimlicoBundlerProxy` — swapping providers (self-hosted, stackup, alchemy)
  is a one-line DI change.
- **`helpers/env/aaEnv.ts`** is the home for AA-stack runtime config
  (timeouts, body caps, per-chain proxied URLs). New AA adapters read from
  here instead of `process.env` directly. Tunables are env-overridable with
  bounded fallbacks — `AA_BUNDLER_TIMEOUT_MS` (1_000..120_000, default
  15_000) and `AA_BUNDLER_MAX_BODY_BYTES` (1_024..4_194_304, default
  262_144).
- **Per-chain bundler URLs are env-only** (`PIMLICO_BUNDLER_URL_<chainId>`).
  Resolved via `getBundlerUrl(chainId)` in `chainConfig.ts`. Stays
  chain-agnostic — the env key is computed from the chainId, never hardcoded
  in adapters or routes.
- **Body forwarding is byte-exact** — the route reads raw bytes (new
  `readRawBody` helper in `httpServer.ts`) and the adapter passes the Buffer
  straight to `fetch`. We must not `JSON.parse → JSON.stringify`: that would
  reorder keys and coerce big-int userOp fields like `nonce`/`callGasLimit`.
- **Auth is Authorization-header only** for `/aa/bundler/*`; we deliberately
  skip the `userId → SCA` cross-check (would require parsing the body and
  defeat the byte-exact forward; pimlico's paymaster verifies the userOp
  downstream).
- **Logger scope `pimlicoBundlerProxy`.** New metadata field names:
  `chainId`, `method`, `bodyBytes`, `upstreamBytes`, `timedOut`,
  `declaredLen` (alongside the standard `reqId`/`status`/`durationMs`/`err`).
  `timedOut: true` distinguishes our timeout ceiling tripping from other
  upstream failures; the route maps it to 504 (vs 502 for other throws,
  503 for `no-bundler-configured`). `declaredLen` is the inbound
  `Content-Length` header used for the 413 pre-check.

## Prediction-market LLM cost reduction — Phase A (2026-05-20)

Plan: `be/constructions/2026-05-20-prediction-markets-llm-cost-reduction.md`.
Goal of Phase A is a quota cut without behaviour change: drop reasoning
effort, raise cache hit rate, all env-flippable.

### What changed

- **Per-call cost knobs are now env-driven** (`predictionMarketEnv.ts`):
  - `PREDICTION_MARKETS_CLASSIFIER_REASONING_EFFORT` (default `"low"`,
    accepts `minimal|low|medium|high`)
  - `PREDICTION_MARKETS_CLASSIFIER_MAX_TOKENS` (default `8000`)
  - `PREDICTION_MARKETS_DETECTOR_REASONING_EFFORT` (default `"low"`)
  - `PREDICTION_MARKETS_DETECTOR_MAX_TOKENS` (default `8000`)
  Adapter configs (`OpenAIPredictionMarketClassifierConfig`,
  `OpenAIPredictionMarketDetectorConfig`) require both fields — wired through
  `assistant.di.ts`. Prior baselines were inlined `(12000, medium)`; restore
  knob for missed findings is `(12000, medium)`, emergency-restore for the
  detector is `(16000, high)` (requires OpenRouter per-request credit cap
  uplift — default cap is ~13k and anything above 402s).
- **Detector cache widened.** `PREDICTION_MARKETS_DETECTOR_PRICE_BUCKET_BPS`
  default 50 → 200 (2¢ buckets — still inside the 4¢ finding-threshold
  pipeline), `PREDICTION_MARKETS_DETECTOR_CACHE_TTL_SEC` default 1800 → 3600
  (so the 30-min scan tick lands at least one hit between drifts).
- **Classifier cache key tightened.** Dropped `resolutionEpochSec` from the
  key; key is now `(promptVersion, model, sha256(sortedMarketIds))`. Worst
  case (a moved resolution date) we serve a stale cluster up to
  `clusterCacheTtlSec` (24h); upstream `reclusterDelta` /
  `maxReclusterAgeMs` still trigger refresh on universe drift.
- **`PREDICTION_MARKETS_RECLUSTER_DELTA`** default 10 → 25. At `topN=100`,
  10% churn between ticks is normal and was forcing a full re-cluster
  every tick.
- **Prompt version bumped v3 → v4** to invalidate pre-change cached drafts
  on first deploy (reasoned under the old budget). The version is part of
  both the classifier and detector cache keys.

### New interface convention — detector returns `DetectorResult`

`IPredictionMarketDetector.detect()` now returns
`{ drafts: DraftFinding[]; cacheHit: boolean }` instead of bare
`DraftFinding[]`. The scan use case rolls `cacheHit` up over LLM-served
clusters only and emits `detectorCacheHits` / `detectorCacheMisses` in the
`step: "stage3-end"` log line — the Grafana signal that proves the A2
widened bucket + TTL bump are actually paying off. The deterministic
detector always returns `cacheHit: false` (no LLM cache to hit), so the
ratio reflects the LLM cache only. Callers must destructure
`{ drafts, cacheHit }` from `detector.detect(...)`.

### New scan-job startup banner field

`llmCost` block on the worker startup log records the effective
classifier/detector reasoning effort, maxTokens, price bucket bps, cache
TTL, and reclusterDelta — so operators can confirm a worker is on the
cheaper defaults without grepping multiple files.

### Verification gate (manual, before merge)

Per the plan, run the worker locally with `PREDICTION_MARKETS_ENABLED=true`
for ≥3 consecutive ticks against prod Polymarket data and confirm:

1. Tick 2/3 show ≥50% `detectorCacheHits / (hits + misses)` over
   LLM-served clusters.
2. No new `finish_reason=length` warnings (the 8000-token budget is plenty
   at `effort: low`; if it fires, raise `…_MAX_TOKENS`).
3. Findings count within ±30% of the pre-change rolling baseline.

Phase B (deterministic detector cut-over by subject) and Phase C
(event-id-first clustering) are not in this change — they remain proposed.

## Prediction-market LLM cost reduction — Phase B audit (2026-05-20)

B1 audit ran against the live DB (latest scan = run
`a00e0dcc-2a5c-445f-9067-bbd32e28e236`, 35 markets). **Phase B cut-over is
blocked**; recording so the next agent doesn't redo the audit.

| Check | Result | Bar |
|---|---|---|
| `measure-subject-distribution.ts` coverage | 22.9% (8/35 matched, 27 OTHER) | ≥85% |
| `prediction_market_facts` populated rows | 4 / 35 markets (all regex_verified) | ~all of topN |
| `prediction_market_findings_shadow` rows in last 7d | 0 | needs population |
| `diff-findings-vs-shadow.ts` per-subject agreement | `BTC_USD_SPOT` 0% (8 LLM-only), `UNKNOWN` 0% (17 LLM-only) | ≥85% per subject |

`PREDICTION_MARKETS_SHADOW_MODE=true` is set — shadow mode is on but
producing zero findings because the deterministic detector short-circuits
with `mode: "facts-missing-or-unverified"` whenever a cluster has any
member without a verified fact. With 4/35 facts, almost every cluster
short-circuits.

OTHER-bucket samples that the seed vocabulary doesn't cover (worth
extending `SUBJECTS` in `marketFactVocabularies.ts`): Iran/Hormuz
geopolitical, MicroStrategy treasury sales, AI-model rankings, Taiwan
invasion, Korean elections, NBA MVP, UK PM tenure.

### Preconditions before Phase B can resume

1. **Vocabulary expansion** — add subject codes for the recurring OTHER
   themes (this is "Part 2" of the deterministic-detection construction
   series, not part of the LLM-cost reduction plan). Re-run
   `measure-subject-distribution.ts`; gate it on the ≥85% floor.
2. **Backfill / accelerate extraction** — currently 11% of the universe has
   facts. The hourly `extractFactsIntervalMs` extractor should converge
   the rest; investigate why it hasn't and whether a one-shot backfill
   over historical snapshots is warranted.
3. **Accumulate shadow data** — once 1 + 2 are in place, leave shadow
   mode running for ≥7 days so `prediction_market_findings_shadow`
   populates and `diff-findings-vs-shadow.ts` can compute meaningful
   per-subject agreement.

Until all three preconditions clear, no subject can be added to
`PREDICTION_MARKETS_DETERMINISTIC_SUBJECTS`, and B3 (further
`detectorMaxTokens` reduction, gated on ≥80% deterministic cut-over)
stays parked.

### Phase B precondition work — partial (2026-05-20)

Acted on (1) and (2) above:

**Vocabulary expansion — `marketFactVocabularies.ts`.** Added six
high-confidence partitions covering the largest OTHER recurring themes
found in the B1 audit: `FIFA_WORLD_CUP_2026_WINNER`,
`EUROVISION_2026_WINNER`, `NHL_STANLEY_CUP_2026_WINNER`,
`IPL_2026_WINNER`, `WTI_CRUDE_USD_SPOT`, `LARGEST_COMPANY_MARKET_CAP`.
`measure-subject-distribution.ts` got matching heuristic classifiers so
the coverage gate re-runs against the expanded list. Out of scope and
intentionally not added: foreign-election variants, MicroStrategy
treasury moves, Elon-tweet counts, one-off geopolitical events — these
have <3 markets each (below the cluster floor) or no clean partition
semantics.

**Verifier vocabulary — `marketFactRegexVerifier.ts`.** Two gaps were
making the LLM's correct outputs fail regex:

- `eq` operator keywords were `equal|exactly|==` only. Both
  "no change in Fed rates" (FED_FUNDS_RATE) and "X wins championship"
  (sports winners) emit `op: eq` legitimately; added
  `no change|unchanged|stays|remains|holds at|win(s|ning)?|becomes?|named`.
- `OFFICIAL_LEAGUE_SCORE` alias was `/official.*score/i, /league.*office/i`
  which matched almost nothing. Broadened to cover the league /
  tournament names that real championship-market criteria reference
  (`nba|nfl|nhl|mlb|ipl|epl|uefa|fifa|premier league|champions league|
  super bowl|stanley cup|finals|world cup|championship`).

Sanity-checked on observed failure cases: "Will there be no change in
Fed interest rates…" (FED_FUNDS_RATE, op=eq, src=FOMC_OFFICIAL) and
"Will the Cleveland Cavaliers win the 2026 NBA Finals?"
(NBA_FINALS_2026_WINNER, op=eq, src=OFFICIAL_LEAGUE_SCORE) both now
verify `ok: true`. All 22 existing `node --test`
`marketFactRegexVerifier.test.ts` assertions still pass.

**Extractor prompt version v1 → v2.** Mostly bookkeeping — the
extractor doesn't cache LLM calls and the usecase re-extracts whenever
no verified fact exists, so the next hourly tick will re-attempt every
review-queued market under the expanded SUBJECTS + loosened verifier.
v2 is the version stamp on facts written from this point.

### Investigation note — extractor review-queue duplication

`predictionMarketExtractFacts.usecase.ts:48` filters by
`!existing.has(m.marketId)` against `prediction_market_facts` only — it
does NOT consult the review queue. Markets stuck in review are
re-extracted on every hourly tick; each failure appends another row to
`prediction_market_extraction_reviews`. The current 478 pending rows
include heavy per-market duplication ("Will the Cleveland Cavaliers
win the 2026 NBA Finals?" appears 25 times). Once vocabulary + verifier
land, the next hourly tick should promote the bulk to verified facts
and the duplication stops naturally. The pre-existing duplicate review
rows are stale data, not a blocker — a separate cleanup pass can
purge them when convenient.

### Remaining Phase B preconditions

(3) above still applies: shadow mode needs ≥7 days post-(1)+(2) to
accumulate enough `prediction_market_findings_shadow` rows for
`diff-findings-vs-shadow.ts` to compute meaningful per-subject
agreement. Re-run the B1 audit then; cut-over only the subjects that
clear the ≥85% bar.

## Prediction-market LLM cost reduction — Phase C (2026-05-20)

Phase C removes the Stage-2 LLM classifier from the hot path by trusting
Polymarket's native `event_id` grouping. Independent of Phase B (which
targets the Stage-3 detector); they touch different pipeline stages.

### C1 audit (latest 35-market scan run)

| Metric | Value |
|---|---|
| `polymarket_event_id` coverage | 35/35 = **100%** |
| Markets in event_id groups ≥ `MIN_CLUSTER_MEMBERS` (3) | 6 (17.1%) |
| Markets in event_id pairs (2) | 14 |
| Singletons | 15 |
| Existing LLM clusters in the run | 3 |
| LLM clusters subsumed by a single event_id | **2/3 (66.7%)** |

Two of three LLM clusters in the latest run are perfectly redundant with
Polymarket's own grouping ("2026 NBA Finals winner", "2026 Peruvian
presidential election"). The third spans 2 event_ids (Binance BTC/USDT
price moves) and is where the LLM contributes genuine cross-event causal
reasoning. Conclusion: event-id-first clustering is a clean win for the
~66% of LLM clusters that just re-discover Polymarket's grouping; the LLM
stays as fallback for cross-event groupings and for markets in singleton
or 2-market event_id buckets.

Audit script: `be/scripts/measure-event-id-coverage.ts`.

### C2 — event_id-first clustering

`predictionMarketDeterministicCluster.usecase.ts` now accepts an
`eventIdFirst: boolean` arg. When true:

1. Group `universe` markets by `polymarketEventId`.
2. Any group with ≥`MIN_CLUSTER_MEMBERS` (3) members and a non-null
   event_id emits a `DraftCluster` with
   `expectedRelationships: [{ kind: 'mutually_exclusive', ... }]` and
   `confidence: 'high'`. No fact lookup; no LLM call.
3. Markets consumed by this pass do NOT enter the existing fact-based
   pass or the LLM classifier — they're added to `usedMarketIds` and
   filtered out of `llmEligible`.

`derivedSubject` is intentionally left null on event_id clusters — they
bypass the fact pipeline, so `pickDetector` still routes them to the LLM
detector (subject-based deterministic detection requires a
`MarketFact.subject` match, which event_id clusters don't have).

### Gating

New env: `PREDICTION_MARKETS_EVENT_ID_CLUSTERING_ENABLED` (default
`false`). Threaded through `predictionMarketScan.usecase.ts` →
`deterministicCluster.cluster({ eventIdFirst })`.

The scan use case now invokes the deterministic clusterer when ANY of
`cutOverSubjects.size > 0 || env.shadowMode || env.eventIdClusteringEnabled`
holds — previously it gated on `cutOverSubjects.size > 0` only. The
clusterer's fact-based pass (and the `factRepo.getByMarketIds` fetch) is
now short-circuited when `!shadowMode && cutOverSubjects.size === 0` so
event_id-only mode doesn't pay for facts it won't use.

### C3 (parked)

The plan's C3 step — drop classifier `reasoningEffort` to `minimal` and
`maxTokens` to 4000 — is gated on C2 being measurably effective in
production. Flip after one full day of `eventIdClusteringEnabled=true`
shows the LLM classifier is mostly serving the long tail; do not flip
preemptively. The Phase A env knobs
(`PREDICTION_MARKETS_CLASSIFIER_REASONING_EFFORT` / `_MAX_TOKENS`)
already make this a one-line env change.

### New scan-job startup banner field

`eventIdClusteringEnabled` is now part of the `flags` block at worker
startup.
