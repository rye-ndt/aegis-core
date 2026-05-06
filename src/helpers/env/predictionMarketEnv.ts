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
  promptVersion: str("PREDICTION_MARKETS_PROMPT_VERSION", "v1"),
} as const;
