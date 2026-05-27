import type { ReasoningEffort } from "../llm/openrouterClient";

function num(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : def;
}

function str(key: string, def: string): string {
  return process.env[key]?.trim() || def;
}

function reasoningEffort(key: string, def: ReasoningEffort): ReasoningEffort {
  const v = process.env[key]?.trim().toLowerCase();
  if (v === "minimal" || v === "low" || v === "medium" || v === "high") return v;
  return def;
}

function bool(key: string, def: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return def;
  return v.trim().toLowerCase() === "true";
}

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
  classifierModel: str(
    "PREDICTION_MARKETS_CLASSIFIER_MODEL",
    "openai/gpt-5-nano",
  ),
  maxCriteriaChars: num("PREDICTION_MARKETS_MAX_CRITERIA_CHARS", 4000),
  // Raised 10 → 25 on 2026-05-20 (LLM-cost reduction plan, Phase A4): with
  // topN=100, 10% churn between ticks is normal and was forcing a full
  // re-cluster every tick.
  reclusterDelta: num("PREDICTION_MARKETS_RECLUSTER_DELTA", 25),
  maxReclusterAgeMs: num("PREDICTION_MARKETS_MAX_RECLUSTER_AGE_MS", 24 * 60 * 60 * 1000),
  clusterCacheTtlSec: num("PREDICTION_MARKETS_CLUSTER_CACHE_TTL_SEC", 24 * 60 * 60),
  broadcastConcurrency: num("PREDICTION_MARKETS_BROADCAST_CONCURRENCY", 5),
  // Part of the classifier/detector Redis cache keys; bumping invalidates
  // pre-change cached drafts on deploy so we don't serve outputs produced
  // under an older prompt or reasoning budget. v4 (2026-05-20) bumps with
  // Phase A — reasoning effort medium → low, classifier cache key drops
  // resolution epoch.
  promptVersion: str("PREDICTION_MARKETS_PROMPT_VERSION", "v4"),
  detectorModel: str(
    "PREDICTION_MARKETS_DETECTOR_MODEL",
    str(
      "PREDICTION_MARKETS_CLASSIFIER_MODEL",
      "openai/gpt-5-nano",
    ),
  ),
  detectorConcurrency: num("PREDICTION_MARKETS_DETECTOR_CONCURRENCY", 3),
  // 2026-05-20 LLM-cost reduction (Phase A2): TTL 30m → 1h so the typical
  // 30-min scan tick lands at least one cache hit between price drifts;
  // bucket 50bps → 200bps quadruples the steady-state hit rate while still
  // preserving 2¢ price movement granularity (well inside the 4¢
  // finding-threshold pipeline).
  detectorCacheTtlSec: num("PREDICTION_MARKETS_DETECTOR_CACHE_TTL_SEC", 3600),
  detectorPriceBucketBps: num("PREDICTION_MARKETS_DETECTOR_PRICE_BUCKET_BPS", 200),
  // 2026-05-20 LLM-cost reduction (Phase A1): both default to "low" effort
  // and an 8k token budget — the classifier/detector were burning the bulk
  // of OpenRouter quota at (12000, medium). Env-flip restore knobs: raise
  // back to (12000, "medium") or, in emergency, (16000, "high") for the
  // detector (the highest-stakes step).
  classifierReasoningEffort: reasoningEffort(
    "PREDICTION_MARKETS_CLASSIFIER_REASONING_EFFORT",
    "low",
  ),
  classifierMaxTokens: num("PREDICTION_MARKETS_CLASSIFIER_MAX_TOKENS", 8000),
  detectorReasoningEffort: reasoningEffort(
    "PREDICTION_MARKETS_DETECTOR_REASONING_EFFORT",
    "low",
  ),
  detectorMaxTokens: num("PREDICTION_MARKETS_DETECTOR_MAX_TOKENS", 8000),
  verifyFreshnessMs: num("PREDICTION_MARKETS_VERIFY_FRESHNESS_MS", 60_000),
  oddsDriftToleranceBps: num("PREDICTION_MARKETS_ODDS_DRIFT_TOLERANCE_BPS", 50),
  minGapBps: num("PREDICTION_MARKETS_MIN_GAP_BPS", 100),
  // For mutually-exclusive clusters, magnitude is `|sum(YES) − 1.0|`. Below
  // this threshold the cluster is properly priced, even if individual prices
  // span a wide range (e.g. 96/3/0 = 99% sum is consensus, not contradiction).
  minSumDeviationBps: num("PREDICTION_MARKETS_MIN_SUM_DEVIATION_BPS", 300),
  findingMinLiquidityUsd: num("PREDICTION_MARKETS_FINDING_MIN_LIQUIDITY_USD", 25_000),
  polymarketAffiliateParam: str("PREDICTION_MARKETS_POLYMARKET_AFFILIATE", ""),
  findingsEnabled: bool("PREDICTION_MARKETS_FINDINGS_ENABLED", false),
  betsEnabled: bool("PREDICTION_MARKETS_BETS_ENABLED", false),
  // Sister tick for the stuck-bet sweeper job. Independent of the position
  // poller cadence: the sweeper re-enqueues lapsed sign-requests for bets
  // whose mini-app session closed mid-flow.
  stuckBetSweepIntervalMs: num("PREDICTION_MARKETS_STUCK_BET_SWEEP_INTERVAL_MS", 30_000),
  // A bet whose updatedAt is older than this and isn't terminal is treated
  // as "the mini-app went away" and re-advanced. Long enough to not collide
  // with a slow legal step (~30s for a userop on Polygon), short enough that
  // a closed-then-reopened mini-app picks up promptly.
  stuckBetTimeoutMs: num("PREDICTION_MARKETS_STUCK_BET_TIMEOUT_MS", 90_000),
  betChainId: num("PREDICTION_MARKETS_BET_CHAIN_ID", 137),
  minStakeUsdc: num("PREDICTION_MARKETS_MIN_STAKE_USDC", 1),
  maxStakeUsdc: num("PREDICTION_MARKETS_MAX_STAKE_USDC", 100),
  maxOrderDriftBps: num("PREDICTION_MARKETS_MAX_ORDER_DRIFT_BPS", 200),
  orderSlippageBps: num("PREDICTION_MARKETS_ORDER_SLIPPAGE_BPS", 50),
  unfilledTimeoutMs: num("PREDICTION_MARKETS_UNFILLED_TIMEOUT_MS", 30_000),
  bridgeTimeoutMs: num("PREDICTION_MARKETS_BRIDGE_TIMEOUT_MS", 90_000),
  positionPollIntervalMs: num("PREDICTION_MARKETS_POSITION_POLL_INTERVAL_MS", 5 * 60 * 1000),
  betIntentTtlMs: num("PREDICTION_MARKETS_INTENT_TTL_MS", 60 * 60 * 1000),
  clobApiBase: str("PREDICTION_MARKETS_CLOB_API", "https://clob.polymarket.com"),
  // 0.05 MATIC funds the EOA for one-time Polymarket approvals during setup.
  maticBootstrapWei: str("PREDICTION_MARKETS_MATIC_BOOTSTRAP_WEI", "50000000000000000"),
  // AES-256-GCM master key, 32 bytes hex (64 chars). REQUIRED before
  // `betsEnabled=true`; the polymarket adapter throws when unsealing existing
  // L2 cred rows without it. (BE-side cred *writes* removed in Slice E-3.)
  credsKeyHex: str("PREDICTION_MARKETS_CREDS_KEY_HEX", ""),
  // Phase 2 (deterministic-detection) — per-market LLM extractor + hourly job.
  // The regex layer is the safety net so a small/cheap model is fine for
  // first-pass structured output.
  extractorModel: str(
    "PREDICTION_MARKETS_EXTRACTOR_MODEL",
    "openai/gpt-5-nano",
  ),
  extractorConcurrency: num("PREDICTION_MARKETS_EXTRACTOR_CONCURRENCY", 8),
  // v1 → v2 (2026-05-20): SUBJECTS vocabulary expanded with six partitions
  // (FIFA / Eurovision / NHL / IPL / WTI crude / largest-cap), and the
  // regex verifier's `eq` keyword list + OFFICIAL_LEAGUE_SCORE aliases
  // broadened. Bumping invalidates the prior model+prompt pinning on
  // `prediction_market_facts` so the hourly job re-extracts.
  extractorPromptVersion: str("PREDICTION_MARKETS_EXTRACTOR_PROMPT_VERSION", "v2"),
  extractFactsIntervalMs: num("PREDICTION_MARKETS_EXTRACT_INTERVAL_MS", 60 * 60 * 1000),
  // Telegram chat id (NOT user id) that receives extraction-review prompts
  // and is gated to handle the approve/edit/reject callbacks. Empty disables
  // the notification surface; reviews still persist for manual SQL handling.
  reviewAdminChatId: str("PREDICTION_MARKETS_REVIEW_ADMIN_CHAT_ID", ""),
  // Phase 3 (Part 4) — deterministic clustering rollout knobs.
  // CSV of `SubjectCode`s. Empty (default) keeps production 100% on the LLM
  // classifier; clusters for subjects listed here are routed through the
  // deterministic clusterer instead and emit `derivedSubject` for Part 5.
  deterministicSubjects: str("PREDICTION_MARKETS_DETERMINISTIC_SUBJECTS", ""),
  // When true, the deterministic clusterer additionally runs over the FULL
  // universe (ignoring cut-over subjects) and writes results to
  // `prediction_market_clusters_shadow` for offline diffing. Shadow output
  // is never broadcast and never feeds the detector.
  shadowMode: bool("PREDICTION_MARKETS_SHADOW_MODE", false),
  // Phase C (2026-05-20 LLM-cost reduction, classifier path). When true,
  // the deterministic clusterer runs an event_id-first pass that groups
  // markets sharing a Polymarket `event_id` into `mutually_exclusive`
  // clusters BEFORE the fact-based pass — bypassing the LLM classifier
  // entirely for those markets. Independent of `deterministicSubjects`
  // (which gates the fact-based path / Phase B cut-over).
  eventIdClusteringEnabled: bool("PREDICTION_MARKETS_EVENT_ID_CLUSTERING_ENABLED", false),
  // Phase 5 (Part 6) — LP sizing. Disabled by default keeps verifier behaviour
  // identical to today; flip after a manual sane-run. The analytical sizer
  // ships in-tree; glpk.js WASM is a future swap-in via the same port.
  sizingEnabled: bool("PREDICTION_MARKETS_SIZING_ENABLED", false),
  sizerBudgetUsdc: num("PREDICTION_MARKETS_SIZER_BUDGET_USDC", 100),
  sizerFeeBps: num("PREDICTION_MARKETS_SIZER_FEE_BPS", 200),
  sizerGasEstimateUsdc: num("PREDICTION_MARKETS_SIZER_GAS_ESTIMATE_USDC", 0.05),
  sizerDepthLevels: num("PREDICTION_MARKETS_SIZER_DEPTH_LEVELS", 10),
  // Bearer-token gate for `GET /admin/prediction-markets/*`. Empty disables
  // the endpoint entirely (returns 404). Operators must set this AND send
  // `Authorization: Bearer <token>` to query the shadow-agreement report.
  adminHttpToken: str("PREDICTION_MARKETS_ADMIN_HTTP_TOKEN", ""),
} as const;
