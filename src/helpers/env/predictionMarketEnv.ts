function num(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : def;
}

function str(key: string, def: string): string {
  return process.env[key]?.trim() || def;
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
  classifierModel: str("PREDICTION_MARKETS_CLASSIFIER_MODEL", "openai/gpt-5-mini"),
  maxCriteriaChars: num("PREDICTION_MARKETS_MAX_CRITERIA_CHARS", 4000),
  reclusterDelta: num("PREDICTION_MARKETS_RECLUSTER_DELTA", 10),
  maxReclusterAgeMs: num("PREDICTION_MARKETS_MAX_RECLUSTER_AGE_MS", 24 * 60 * 60 * 1000),
  clusterCacheTtlSec: num("PREDICTION_MARKETS_CLUSTER_CACHE_TTL_SEC", 24 * 60 * 60),
  broadcastConcurrency: num("PREDICTION_MARKETS_BROADCAST_CONCURRENCY", 5),
  // Bumped from v1 → v2 alongside the verifier's pattern-aware magnitude fix
  // and the detector prompt's mutually-exclusive anti-example / calibration
  // additions. v2 → v3 is Phase 0 of the deterministic-detection plan: the
  // detector now emits per-finding role tags (wider/narrower or earlier/later)
  // and the verifier drops wrong-direction findings. The version is part of
  // the detector Redis cache key, so the bump invalidates pre-fix cached
  // drafts on first deploy.
  promptVersion: str("PREDICTION_MARKETS_PROMPT_VERSION", "v3"),
  detectorModel: str(
    "PREDICTION_MARKETS_DETECTOR_MODEL",
    str("PREDICTION_MARKETS_CLASSIFIER_MODEL", "openai/gpt-5-mini"),
  ),
  detectorConcurrency: num("PREDICTION_MARKETS_DETECTOR_CONCURRENCY", 3),
  detectorCacheTtlSec: num("PREDICTION_MARKETS_DETECTOR_CACHE_TTL_SEC", 1800),
  detectorPriceBucketBps: num("PREDICTION_MARKETS_DETECTOR_PRICE_BUCKET_BPS", 50),
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
  // `betsEnabled=true`; storePolymarketCreds throws if empty.
  credsKeyHex: str("PREDICTION_MARKETS_CREDS_KEY_HEX", ""),
  // Phase 2 (deterministic-detection) — per-market LLM extractor + hourly job.
  // The regex layer is the safety net so a small/cheap model is fine for
  // first-pass structured output.
  extractorModel: str("PREDICTION_MARKETS_EXTRACTOR_MODEL", "openai/gpt-5-mini"),
  extractorConcurrency: num("PREDICTION_MARKETS_EXTRACTOR_CONCURRENCY", 8),
  extractorPromptVersion: str("PREDICTION_MARKETS_EXTRACTOR_PROMPT_VERSION", "v1"),
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
