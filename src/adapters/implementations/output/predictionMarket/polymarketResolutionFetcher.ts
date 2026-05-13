/**
 * Gamma-backed resolution fetcher for the paper-bet resolution job (Part 3).
 *
 * Uses the same `condition_ids=` query convention `polymarketProvider.fetchByIds`
 * relies on (Gamma silently returns `[]` for comma-joined ids; only repeated
 * query params work). `fetchMany` batches under that convention so a 50-market
 * tick costs one HTTP round-trip, not 50.
 */

import { PREDICTION_MARKETS_ENV } from "../../../../helpers/env/predictionMarketEnv";
import { createLogger } from "../../../../helpers/observability/logger";
import { parseMaybeJsonArray } from "./gammaUtils";
import type {
  IPolymarketResolutionFetcher,
  MarketResolution,
} from "../../../../use-cases/interface/predictionMarket/IPolymarketResolutionFetcher";

const log = createLogger("polymarketResolutionFetcher");

/** Max ids per Gamma `/markets` call. Mirrors `polymarketProvider.fetchByIds`. */
const FETCH_BATCH = 50;

interface GammaMarket {
  conditionId?: string;
  id?: string;
  resolved?: boolean;
  closed?: boolean;
  archived?: boolean;
  acceptingOrders?: boolean;
  umaResolutionStatus?: string;
  /** Stored as JSON string of `["1","0"]` etc., or as an array directly. */
  outcomePrices?: string | string[];
  outcomes?: string | string[];
  closedTime?: string;
  endDate?: string;
}

export class PolymarketResolutionFetcher implements IPolymarketResolutionFetcher {
  constructor(
    private readonly gammaApiBase: string = PREDICTION_MARKETS_ENV.gammaApiBase,
  ) {}

  async fetch(marketId: string): Promise<MarketResolution | null> {
    const out = await this.fetchMany([marketId]);
    return out[0] ?? null;
  }

  async fetchMany(marketIds: string[]): Promise<MarketResolution[]> {
    const unique = Array.from(new Set(marketIds.filter((id) => id && id.trim().length > 0)));
    if (unique.length === 0) return [];
    const base = this.gammaApiBase.replace(/\/$/, "");
    const out: MarketResolution[] = [];

    for (let i = 0; i < unique.length; i += FETCH_BATCH) {
      const chunk = unique.slice(i, i + FETCH_BATCH);
      const params = chunk.map((id) => `condition_ids=${encodeURIComponent(id)}`).join("&");
      const url = `${base}/markets?${params}&limit=${chunk.length}`;

      let rows: GammaMarket[];
      try {
        const response = await fetch(url, { method: "GET" });
        if (!response.ok) {
          log.warn({ status: response.status, count: chunk.length }, "resolution-fetch http-error");
          continue;
        }
        const json = (await response.json()) as GammaMarket[] | { markets?: GammaMarket[] };
        rows = Array.isArray(json) ? json : json.markets ?? [];
      } catch (err) {
        log.warn({ err, count: chunk.length }, "resolution-fetch failed");
        continue;
      }

      const byId = new Map<string, GammaMarket>();
      for (const r of rows) {
        const id = r.conditionId ?? r.id;
        if (id) byId.set(id, r);
      }
      for (const marketId of chunk) {
        const row = byId.get(marketId);
        const resolution = row ? toResolution(marketId, row) : null;
        if (resolution) out.push(resolution);
      }
    }
    return out;
  }
}

function toResolution(marketId: string, row: GammaMarket): MarketResolution | null {
  if (row.umaResolutionStatus && row.umaResolutionStatus.toLowerCase() === "disputed") {
    log.debug({ marketId, umaResolutionStatus: row.umaResolutionStatus }, "resolution in-dispute");
    return null;
  }
  if (row.resolved !== true) return null;

  const outcomeIdx = pickOutcomeIndex(row.outcomePrices);
  if (outcomeIdx === null) {
    log.warn({ marketId, outcomePrices: row.outcomePrices }, "resolution ambiguous outcome");
    return null;
  }
  const outcome = mapOutcomeIndex(row.outcomes, outcomeIdx);
  if (!outcome) {
    log.warn({ marketId, outcomes: row.outcomes, outcomeIdx }, "resolution unknown outcome label");
    return null;
  }
  const resolvedAt = parseSettlementDate(row);
  log.info({ marketId, outcome, resolvedAt: resolvedAt.toISOString() }, "resolution-fetched");
  return { marketId, outcome, resolvedAt, source: "polymarket-gamma" };
}

/**
 * Returns the index (0 or 1) of the winning outcome, or null when the prices
 * are ambiguous (e.g. `[0.5, 0.5]`, missing, more than two outcomes, etc.).
 * Settled binaries always close at exactly 1/0.
 */
function pickOutcomeIndex(raw: GammaMarket["outcomePrices"]): 0 | 1 | null {
  const arr = parseMaybeJsonArray<string | number>(raw);
  if (arr.length !== 2) return null;
  const a = Number(arr[0]);
  const b = Number(arr[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a >= 0.99 && b <= 0.01) return 0;
  if (b >= 0.99 && a <= 0.01) return 1;
  return null;
}

function mapOutcomeIndex(
  rawOutcomes: GammaMarket["outcomes"],
  idx: 0 | 1,
): "YES" | "NO" | null {
  const outcomes = parseMaybeJsonArray<string>(rawOutcomes);
  if (outcomes.length !== 2) return null;
  const label = outcomes[idx]?.toUpperCase();
  if (label === "YES" || label === "NO") return label;
  return null;
}

function parseSettlementDate(row: GammaMarket): Date {
  const candidate = row.closedTime ?? row.endDate;
  if (candidate) {
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}
