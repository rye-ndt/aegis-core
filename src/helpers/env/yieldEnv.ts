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
  /** Per-user rebalance scan cadence; gated independently from idle USDC scan. */
  rebalanceCheckIntervalMs: num("YIELD_REBALANCE_CHECK_INTERVAL_MS", 24 * 60 * 60 * 1000),
  /** Minimum APY uplift in bps required to nudge (winner − current). 50 = 0.5%. */
  rebalanceMinDeltaBps: num("YIELD_REBALANCE_MIN_DELTA_BPS", 50),
  /** Winner must remain top for N consecutive pool scans before nudging — hysteresis. */
  rebalanceStickyScans: num("YIELD_REBALANCE_STICKY_SCANS", 3),
  /** Cooldown between rebalance nudges per user. */
  rebalanceNudgeCooldownSec: num("YIELD_REBALANCE_NUDGE_COOLDOWN_SEC", 86_400),
} as const;
