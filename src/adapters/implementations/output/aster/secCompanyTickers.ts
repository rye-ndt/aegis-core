import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("secCompanyTickers");

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
// SEC requires a descriptive User-Agent. Spoofing a browser is forbidden by
// their fair-access policy; "Aegis ops@aegis" satisfies the rule.
// IMPORTANT: HTTP headers must be Latin-1 — keep this ASCII-only. An em dash
// here will throw `TypeError: Cannot convert argument to a ByteString`.
const USER_AGENT =
  process.env.SEC_USER_AGENT?.trim() ||
  "Aegis (ops@aegis.example) tokenized-stock metadata sync";

const TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  byTicker: Map<string, string>; // ticker → company name
}

let cache: CacheEntry | null = null;

/**
 * Fetch the SEC EDGAR company-tickers JSON and return a `ticker → title` map.
 * 24h in-memory TTL — company names rarely change. Failures fall back to the
 * last-known cache; if there is no cache yet, returns an empty map and the
 * caller should treat every symbol as having no friendly name.
 */
export async function getSecTickerNameMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) {
    log.debug({ choice: "hit", count: cache.byTicker.size }, "sec-cache");
    return cache.byTicker;
  }

  log.debug({ choice: "miss" }, "sec-cache");
  try {
    const start = Date.now();
    const res = await fetch(SEC_TICKERS_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      log.warn({ status: res.status, url: SEC_TICKERS_URL }, "sec fetch failed");
      return cache?.byTicker ?? new Map();
    }
    const json = (await res.json()) as Record<
      string,
      { cik_str: number; ticker: string; title: string }
    >;
    const byTicker = new Map<string, string>();
    for (const row of Object.values(json)) {
      if (!row?.ticker || !row.title) continue;
      byTicker.set(row.ticker.toUpperCase(), row.title);
    }
    cache = { fetchedAt: now, byTicker };
    log.info(
      { count: byTicker.size, durationMs: Date.now() - start },
      "sec ticker map refreshed",
    );
    return byTicker;
  } catch (err) {
    log.error({ err }, "sec fetch threw");
    return cache?.byTicker ?? new Map();
  }
}
