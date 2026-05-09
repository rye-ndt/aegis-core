function num(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : def;
}

function str(key: string, def: string): string {
  return process.env[key]?.trim() || def;
}

export const RELAY_ENV = {
  slippageBps: num("RELAY_SLIPPAGE_BPS", 100),
  referrer: str("RELAY_REFERRER", "aegis"),
} as const;
