function num(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : def;
}

/**
 * Initial spending caps applied at session-key onboarding *and* on stable-coin
 * re-approvals. Values are in human units (e.g. 100 means 100 USDC). Native
 * is per-chain at the same numeric value across chains — operators wanting
 * different native budgets per chain should set this conservatively for the
 * lowest-priced native. Re-approval logic for non-stable tokens does not use
 * these envs (it uses 10× the send-intent amount instead).
 */
/** Token symbols treated as stable coins for re-approval flow. */
export const STABLE_SYMBOLS: ReadonlySet<string> = new Set(["USDC", "USDT"]);

export function isStableSymbol(symbol: string): boolean {
  return STABLE_SYMBOLS.has(symbol.toUpperCase());
}

export const DELEGATION_ENV = {
  initialUsdc: num("INITIAL_USDC", 100),
  initialUsdt: num("INITIAL_USDT", 100),
  initialNative: num("INITIAL_NATIVE", 10),
  /** Multiplier applied to the failing send-intent amount when re-approving a non-stable token. */
  nonStableReapprovalMultiplier: num("NON_STABLE_REAPPROVAL_MULTIPLIER", 10),
} as const;
