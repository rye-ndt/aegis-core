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
  classifierModel: str("PREDICTION_MARKETS_CLASSIFIER_MODEL", "gpt-4o"),
  maxCriteriaChars: num("PREDICTION_MARKETS_MAX_CRITERIA_CHARS", 4000),
  reclusterDelta: num("PREDICTION_MARKETS_RECLUSTER_DELTA", 10),
  maxReclusterAgeMs: num("PREDICTION_MARKETS_MAX_RECLUSTER_AGE_MS", 24 * 60 * 60 * 1000),
  clusterCacheTtlSec: num("PREDICTION_MARKETS_CLUSTER_CACHE_TTL_SEC", 24 * 60 * 60),
  broadcastConcurrency: num("PREDICTION_MARKETS_BROADCAST_CONCURRENCY", 5),
  // Bumped from v1 → v2 alongside the verifier's pattern-aware magnitude fix
  // and the detector prompt's mutually-exclusive anti-example / calibration
  // additions. The version is part of the detector Redis cache key, so the
  // bump invalidates pre-fix cached drafts on first deploy.
  promptVersion: str("PREDICTION_MARKETS_PROMPT_VERSION", "v2"),
  detectorModel: str(
    "PREDICTION_MARKETS_DETECTOR_MODEL",
    str("PREDICTION_MARKETS_CLASSIFIER_MODEL", "gpt-4o"),
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
} as const;
