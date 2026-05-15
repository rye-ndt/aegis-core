/**
 * AA-stack runtime config (AA bundler proxy timeouts/caps; per-chain pimlico
 * URLs). Future AA infrastructure adapters (paymaster proxy, alt-bundler) read
 * from this module instead of touching `process.env` directly.
 */

const KEY_PREFIX = "PIMLICO_BUNDLER_URL_";

/**
 * Resolved per-chain bundler URL cache. Keyed by `chainId` (one entry per
 * chain, ever) — the stored `raw` is compared on read so a mutation in env
 * between calls invalidates without leaving the prior entry behind. Prod env
 * is fixed at boot, so steady state is one URL parse per chain for the
 * process lifetime; tests that swap env between cases stay bounded.
 */
const URL_CACHE = new Map<number, { raw: string; resolved: string | null }>();

/**
 * Resolve the per-chain pimlico bundler URL from env. Returns null when the
 * key is unset or the value is not a valid `https://` URL — the caller (HTTP
 * route) surfaces that as 503 so a typo doesn't leak as a 502 in prod.
 *
 * Env key format: `PIMLICO_BUNDLER_URL_<chainId>` (e.g.
 * `PIMLICO_BUNDLER_URL_43114`). Chain-agnostic by construction: the key is
 * computed from the chainId, never hardcoded.
 */
export function readBundlerUrl(chainId: number): string | null {
  const raw = process.env[`${KEY_PREFIX}${chainId}`]?.trim() ?? "";
  const cached = URL_CACHE.get(chainId);
  if (cached && cached.raw === raw) return cached.resolved;

  let resolved: string | null = null;
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:") resolved = raw;
    } catch {
      resolved = null;
    }
  }
  URL_CACHE.set(chainId, { raw, resolved });
  return resolved;
}

function num(key: string, def: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return def;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return def;
  return parsed;
}

/**
 * AA-stack runtime tunables. Defaults are conservative and known-good; ops
 * can override via env without a redeploy. Bounds reject obviously broken
 * values (negative, NaN, absurdly large) so a typo doesn't silently disable
 * the body cap or push the timeout into the hours.
 *
 * - `AA_BUNDLER_TIMEOUT_MS`     1_000 ≤ default 15_000 ≤ 120_000
 * - `AA_BUNDLER_MAX_BODY_BYTES` 1_024 ≤ default 262_144 ≤ 4_194_304
 *
 * Values are read **lazily** on each property access (via getters) rather
 * than frozen at module import. In production this costs one env lookup
 * per AA-route hit (negligible). In tests it means `process.env.X = "..."`
 * in a `beforeEach` actually takes effect — the alternative would force
 * tests to re-import the module after every env mutation.
 */
export const AA_ENV = {
  get bundlerRequestTimeoutMs(): number {
    return num("AA_BUNDLER_TIMEOUT_MS", 15_000, 1_000, 120_000);
  },
  get bundlerMaxBodyBytes(): number {
    return num("AA_BUNDLER_MAX_BODY_BYTES", 256 * 1024, 1_024, 4 * 1024 * 1024);
  },
} as const;
