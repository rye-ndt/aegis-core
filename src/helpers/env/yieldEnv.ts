function num(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : def;
}

function list(key: string, def: number[]): number[] {
  const v = process.env[key];
  if (!v) return def;
  return v.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
}

function str(key: string, def: string): string {
  return process.env[key]?.trim() || def;
}

export const YIELD_ENV = {
  idleUsdcThresholdUsd: num("YIELD_IDLE_USDC_THRESHOLD_USD", 10),
  poolScanIntervalMs: num("YIELD_POOL_SCAN_INTERVAL_MS", 30 * 60 * 1000),
  userScanIntervalMs: num("YIELD_USER_SCAN_INTERVAL_MS", 30 * 60 * 1000),
  reportUtcHour: num("YIELD_REPORT_UTC_HOUR", 9),
  reportIntervalMs: num("YIELD_REPORT_INTERVAL_MS", 0),
  nudgeCooldownSec: num("YIELD_NUDGE_COOLDOWN_SEC", 1_800),
  enabledChainIds: list("YIELD_ENABLED_CHAIN_IDS", [43114]),
  /** The Graph API key for the Messari Aave V3 subgraph principal queries. */
  theGraphApiKey: str("THEGRAPH_API_KEY", ""),
} as const;
