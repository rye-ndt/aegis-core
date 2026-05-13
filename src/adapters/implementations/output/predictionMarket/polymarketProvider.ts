import { PREDICTION_MARKETS_ENV } from "../../../../helpers/env/predictionMarketEnv";
import { createLogger } from "../../../../helpers/observability/logger";
import { LRUCache } from "lru-cache";
import type {
  IPredictionMarketProvider,
  OutcomeTokenPair,
  ProviderFilters,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketProvider";
import type { RawMarket } from "../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";
import { parseMaybeJsonArray } from "./gammaUtils";

const log = createLogger("polymarketProvider");

const PAGE_SIZE = 500;
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 250;
const SECS_PER_DAY = 86_400;

interface GammaMarket {
  id?: string;
  conditionId?: string;
  slug?: string;
  question?: string;
  description?: string;
  category?: string | null;
  endDate?: string;                  // ISO
  endDateIso?: string;               // ISO (some endpoints)
  outcomes?: string | string[];      // sometimes JSON-encoded
  outcomePrices?: string | string[]; // ditto
  liquidityNum?: number;
  volumeNum?: number;
  volume24hr?: number;
  volume7d?: number;
  volume1wk?: number;
  openInterest?: number;
  openInterestNum?: number;
  closed?: boolean;
  archived?: boolean;
  active?: boolean;
  acceptingOrders?: boolean;
  umaResolutionStatus?: string | null;
  events?: Array<{ id?: string; description?: string; slug?: string }>;
  oneDayPriceChange?: number;        // decimal fraction, e.g. 0.0234 = +234 bps
  oneWeekPriceChange?: number;
  // CLOB outcome token ids — JSON-encoded `[yesTokenId, noTokenId]` aligned
  // with the `outcomes` array. Drives the sizer's outcomeTokenIdResolver.
  clobTokenIds?: string | string[];
}

function isBinaryYesNo(outcomes: string[]): boolean {
  if (outcomes.length !== 2) return false;
  const lc = outcomes.map((o) => o.toLowerCase());
  return lc.includes("yes") && lc.includes("no");
}

function pickResolutionCriteria(m: GammaMarket): string {
  if (m.description && m.description.trim().length > 0) return m.description.trim();
  const fromEvents = m.events?.find((e) => e.description && e.description.trim().length > 0)?.description;
  return (fromEvents ?? "").trim();
}

function pickOpenInterestUsd(m: GammaMarket): number {
  return Number(m.openInterestNum ?? m.openInterest ?? 0) || 0;
}

function pickVolume7dUsd(m: GammaMarket): number {
  return Number(m.volume7d ?? m.volume1wk ?? 0) || 0;
}

function pickPriceChangeBps(decimal: number | undefined): number | undefined {
  if (decimal === undefined || decimal === null) return undefined;
  const n = Number(decimal);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 10_000);
}

function pickPolymarketEventId(m: GammaMarket): string | null {
  const id = m.events?.[0]?.id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

function pickResolutionEpochSec(m: GammaMarket): number | null {
  const iso = m.endDate ?? m.endDateIso;
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / 1000);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchPage(url: string): Promise<GammaMarket[]> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url);
      lastStatus = res.status;
      if (!res.ok) {
        log.warn({ status: res.status, url, attempt }, "polymarket fetch failed");
        if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_BACKOFF_MS * attempt);
        continue;
      }
      const body = (await res.json()) as GammaMarket[] | { data?: GammaMarket[] };
      const arr = Array.isArray(body) ? body : (body.data ?? []);
      log.debug({ status: res.status, url, count: arr.length }, "polymarket fetch");
      return arr;
    } catch (err) {
      log.warn({ err, url, attempt }, "polymarket fetch error");
      if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  log.error({ status: lastStatus, url }, "polymarket fetch exhausted");
  return [];
}

const FETCH_BY_IDS_BATCH = 50;

function normalizeRaw(m: GammaMarket): RawMarket | null {
  const marketId = (m.conditionId ?? m.id ?? "").trim();
  if (!marketId) return null;
  const outcomes = parseMaybeJsonArray<string>(m.outcomes);
  if (outcomes.length !== 2) return null;
  const resolutionEpochSec = pickResolutionEpochSec(m) ?? 0;
  const resolutionCriteria = pickResolutionCriteria(m);
  const prices = parseMaybeJsonArray<string | number>(m.outcomePrices);
  const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
  const noIdx = outcomes.findIndex((o) => o.toLowerCase() === "no");
  const yesPrice = Number(prices[yesIdx] ?? 0) || 0;
  const noPrice = Number(prices[noIdx] ?? 0) || 0;
  const slug = m.slug ?? "";
  const url = slug ? `https://polymarket.com/market/${slug}` : `https://polymarket.com/`;
  return {
    marketId,
    slug,
    question: m.question ?? "",
    resolutionCriteria,
    category: m.category ?? null,
    resolutionEpochSec,
    yesPrice,
    noPrice,
    openInterestUsd: pickOpenInterestUsd(m),
    volume7dUsd: pickVolume7dUsd(m),
    liquidityUsd: Number(m.liquidityNum ?? 0) || 0,
    isActive: m.closed !== true && m.archived !== true,
    isDisputed:
      m.acceptingOrders === false ||
      (m.umaResolutionStatus?.toLowerCase() === "disputed"),
    outcomesCount: outcomes.length,
    url,
    priceChange24hBps: pickPriceChangeBps(m.oneDayPriceChange),
    priceChange7dBps: pickPriceChangeBps(m.oneWeekPriceChange),
    polymarketEventId: pickPolymarketEventId(m),
  };
}

/** Process-wide LRU keyed on Polymarket condition_id. Populated by every
 *  `fetchFiltered` / `fetchByIds` call; read by the sync resolver below.
 *  Capacity covers ~2x the default topN so back-to-back ticks rarely evict
 *  members that the verifier might still ask about. */
const TOKEN_CACHE_MAX = 500;
const TOKEN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export class PolymarketProvider implements IPredictionMarketProvider {
  private readonly tokenCache = new LRUCache<string, OutcomeTokenPair>({
    max: TOKEN_CACHE_MAX,
    ttl: TOKEN_CACHE_TTL_MS,
  });

  getOutcomeTokens(marketId: string): OutcomeTokenPair | null {
    return this.tokenCache.get(marketId) ?? null;
  }

  private cacheTokensFromGamma(
    marketId: string,
    outcomes: string[],
    rawTokens: unknown,
  ): void {
    const tokens = parseMaybeJsonArray<string>(rawTokens as string | string[] | undefined);
    if (tokens.length !== 2 || outcomes.length !== 2) return;
    const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
    const noIdx = outcomes.findIndex((o) => o.toLowerCase() === "no");
    if (yesIdx < 0 || noIdx < 0) return;
    const yes = tokens[yesIdx];
    const no = tokens[noIdx];
    if (!yes || !no) return;
    this.tokenCache.set(marketId, { yes, no });
  }

  async fetchFiltered(filters: ProviderFilters, reqId: string): Promise<RawMarket[]> {
    const start = Date.now();
    log.info({ step: "started", reqId }, "fetch-universe");

    const base = PREDICTION_MARKETS_ENV.gammaApiBase.replace(/\/$/, "");
    const maxPages = PREDICTION_MARKETS_ENV.maxFetchPages;

    const collected: GammaMarket[] = [];
    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * PAGE_SIZE;
      // `&order=liquidity` is broken on Gamma (returns dust markets first);
      // `&order=volume24hr` returns the real top markets.
      const url =
        `${base}/markets` +
        `?active=true&closed=false&archived=false` +
        `&limit=${PAGE_SIZE}&offset=${offset}` +
        `&order=volume24hr&ascending=false`;
      const rows = await fetchPage(url);
      collected.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const minResolveAt = nowSec + filters.minDaysToResolution * SECS_PER_DAY;
    const maxResolveAt = nowSec + filters.maxDaysToResolution * SECS_PER_DAY;

    const surviving: RawMarket[] = [];
    for (const m of collected) {
      const marketId = (m.conditionId ?? m.id ?? "").trim();
      if (!marketId) continue;

      if (m.closed === true || m.archived === true) continue;
      // Treat halted markets (not accepting orders despite being open) as disputed.
      if (m.acceptingOrders === false) continue;
      if (m.umaResolutionStatus && m.umaResolutionStatus.toLowerCase() === "disputed") continue;

      const outcomes = parseMaybeJsonArray<string>(m.outcomes);
      if (!isBinaryYesNo(outcomes)) continue;

      const resolutionEpochSec = pickResolutionEpochSec(m);
      if (resolutionEpochSec === null) continue;
      if (resolutionEpochSec < minResolveAt || resolutionEpochSec > maxResolveAt) continue;

      const resolutionCriteria = pickResolutionCriteria(m);
      if (resolutionCriteria.length === 0) continue;

      // Gamma's `/markets` endpoint never populates `openInterest*`; treat the
      // OI floor as advisory — only reject when the API actually returns a
      // value AND it's below the threshold. If Polymarket starts exposing OI
      // later, the gate engages automatically.
      const openInterestUsd = pickOpenInterestUsd(m);
      if (openInterestUsd > 0 && openInterestUsd < filters.minOpenInterestUsd) continue;

      const volume7dUsd = pickVolume7dUsd(m);
      if (volume7dUsd < filters.minVolume7dUsd) continue;

      const prices = parseMaybeJsonArray<string | number>(m.outcomePrices);
      const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
      const noIdx = outcomes.findIndex((o) => o.toLowerCase() === "no");
      const yesPrice = Number(prices[yesIdx] ?? 0) || 0;
      const noPrice = Number(prices[noIdx] ?? 0) || 0;

      const liquidityUsd = Number(m.liquidityNum ?? 0) || 0;
      const slug = m.slug ?? "";
      const url = slug ? `https://polymarket.com/market/${slug}` : `https://polymarket.com/`;

      this.cacheTokensFromGamma(marketId, outcomes, m.clobTokenIds);
      surviving.push({
        marketId,
        slug,
        question: m.question ?? "",
        resolutionCriteria,
        category: m.category ?? null,
        resolutionEpochSec,
        yesPrice,
        noPrice,
        openInterestUsd,
        volume7dUsd,
        liquidityUsd,
        isActive: true,
        isDisputed: false,
        outcomesCount: 2,
        url,
        priceChange24hBps: pickPriceChangeBps(m.oneDayPriceChange),
        priceChange7dBps: pickPriceChangeBps(m.oneWeekPriceChange),
        polymarketEventId: pickPolymarketEventId(m),
      });
    }

    // Final ranking by 7d volume — proxy for "real activity" since Gamma
    // doesn't expose OI and `liquidityNum` is order-book depth (often tiny
    // even on multi-million-dollar markets).
    surviving.sort((a, b) => b.volume7dUsd - a.volume7dUsd);
    const top = surviving.slice(0, filters.topN);

    log.info(
      {
        step: "succeeded",
        reqId,
        fetched: collected.length,
        surviving: top.length,
        durationMs: Date.now() - start,
      },
      "fetch-universe",
    );
    return top;
  }

  async fetchByIds(ids: string[], reqId: string): Promise<RawMarket[]> {
    const start = Date.now();
    const unique = Array.from(new Set(ids.filter((id) => id && id.trim().length > 0)));
    if (unique.length === 0) return [];
    log.info({ step: "started", reqId, count: unique.length }, "fetch-by-ids");

    const base = PREDICTION_MARKETS_ENV.gammaApiBase.replace(/\/$/, "");
    const out: RawMarket[] = [];

    for (let i = 0; i < unique.length; i += FETCH_BY_IDS_BATCH) {
      const chunk = unique.slice(i, i + FETCH_BY_IDS_BATCH);
      // Gamma's `/markets` only honors `condition_ids` as repeated query
      // params — comma-joined values silently return [].
      const params = chunk
        .map((id) => `condition_ids=${encodeURIComponent(id)}`)
        .join("&");
      const url = `${base}/markets?${params}&limit=${chunk.length}`;
      const rows = await fetchPage(url);
      for (const r of rows) {
        const norm = normalizeRaw(r);
        if (norm && chunk.includes(norm.marketId)) {
          const outcomes = parseMaybeJsonArray<string>(r.outcomes);
          this.cacheTokensFromGamma(norm.marketId, outcomes, r.clobTokenIds);
          out.push(norm);
        }
      }
    }

    if (out.length < unique.length) {
      log.warn(
        { reqId, requested: unique.length, returned: out.length },
        "fetch-by-ids partial — Gamma may be ignoring `condition_ids=` filter",
      );
    }
    log.info(
      { step: "succeeded", reqId, requested: unique.length, returned: out.length, durationMs: Date.now() - start },
      "fetch-by-ids",
    );
    return out;
  }
}
