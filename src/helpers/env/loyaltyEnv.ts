function num(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : def;
}

export const LOYALTY_ENV = {
  activeSeasonCacheTtlMs: num("LOYALTY_ACTIVE_SEASON_CACHE_TTL_MS", 60_000),
  leaderboardCacheTtlMs: num("LOYALTY_LEADERBOARD_CACHE_TTL_MS", 30_000),
  leaderboardDefaultLimit: num("LOYALTY_LEADERBOARD_DEFAULT_LIMIT", 100),
  leaderboardMaxLimit: num("LOYALTY_LEADERBOARD_MAX_LIMIT", 1000),
} as const;
