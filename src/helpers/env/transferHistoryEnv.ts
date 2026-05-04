function num(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : def;
}

export const TRANSFER_HISTORY_ENV = {
  perUserRpm: num("TRANSFER_HISTORY_RPM_USER", 3),
  rpsGlobal: num("TRANSFER_HISTORY_RPS_GLOBAL", 10),
  pageTtlSecRecent: num("TRANSFER_HISTORY_PAGE_TTL_SEC", 60),
  pageTtlSecOlder: num("TRANSFER_HISTORY_PAGE_OLDER_TTL_SEC", 300),
  staleTtlSec: num("TRANSFER_HISTORY_STALE_TTL_SEC", 900),
} as const;
