/**
 * Controlled vocabularies for `MarketFact`. Seed values from the Phase 1 plan
 * (`constructions/2026-05-11-prediction-markets-deterministic-detection-part2.md`).
 * `scripts/measure-subject-distribution.ts` verifies the seed list covers
 * ≥85% of the current top-N universe; expand here before merging Part 3.
 */

export const SUBJECTS = [
  "BTC_USD_SPOT",
  "ETH_USD_SPOT",
  "SOL_USD_SPOT",
  "FED_FUNDS_RATE",
  "CPI_YOY",
  "US_PRES_2028",
  "US_HOUSE_2026",
  "US_SENATE_2026",
  "NFL_SUPER_BOWL_LX_WINNER",
  "NBA_FINALS_2026_WINNER",
  "EPL_TITLE_2025_26",
  "OSCARS_2026_BEST_PICTURE",
  "WEATHER_NYC_TEMP",
  "BTC_DOMINANCE",
  "ETH_USD_PCT_VS_BTC",
  "RECESSION_CALL_2026",
  "SP500_LEVEL",
  "NASDAQ_LEVEL",
  "UEFA_CHAMPIONS_LEAGUE_2025_26",
  // 2026-05-20 expansion (Phase B unblock). Seed audit (B1) found these as
  // the largest OTHER-bucket recurring partitions: FIFA / Eurovision /
  // NHL / IPL all map cleanly to mutually-exclusive winner sets;
  // WTI_CRUDE_USD_SPOT mirrors BTC_USD_SPOT for the crude-oil threshold
  // markets; LARGEST_COMPANY_MARKET_CAP is the rotating "biggest co. on
  // date X" partition (Microsoft / Tesla / Aramco / Apple variants).
  "FIFA_WORLD_CUP_2026_WINNER",
  "EUROVISION_2026_WINNER",
  "NHL_STANLEY_CUP_2026_WINNER",
  "IPL_2026_WINNER",
  "WTI_CRUDE_USD_SPOT",
  "LARGEST_COMPANY_MARKET_CAP",
  /** Sentinel — any market the LLM can't match goes here AND is forced into
   *  the review queue. `OTHER` markets never enter the hot path. */
  "OTHER",
] as const;

export type SubjectCode = (typeof SUBJECTS)[number];

export const SUBJECT_SET: ReadonlySet<SubjectCode> = new Set(SUBJECTS);

export function isSubjectCode(s: string): s is SubjectCode {
  return SUBJECT_SET.has(s as SubjectCode);
}

export const RESOLUTION_SOURCES = [
  "COINBASE_PRO_USD",
  "COINGECKO_TWAP_1H",
  "KRAKEN_USD",
  "BLS_OFFICIAL",
  "FOMC_OFFICIAL",
  "AP_CALL",
  "OFFICIAL_LEAGUE_SCORE",
  "UMA_PROSE_JUDGMENT",
  "BLOOMBERG_TERMINAL",
  "OTHER",
] as const;

export type ResolutionSourceCode = (typeof RESOLUTION_SOURCES)[number];

export const RESOLUTION_SOURCE_SET: ReadonlySet<ResolutionSourceCode> = new Set(
  RESOLUTION_SOURCES,
);

export function isResolutionSourceCode(s: string): s is ResolutionSourceCode {
  return RESOLUTION_SOURCE_SET.has(s as ResolutionSourceCode);
}

/**
 * Crypto spot sources are pairwise INCOMPATIBLE: a finding "BTC ≥ 95k by
 * Coinbase" vs "BTC ≥ 95k by Coingecko" is an oracle disagreement, not an
 * arbitrage. UMA and league-score sources only compatible with themselves.
 * Same-source is always compatible (covered by the helper, not the map).
 */
export const RESOLUTION_COMPATIBILITY: ReadonlyMap<
  ResolutionSourceCode,
  ReadonlySet<ResolutionSourceCode>
> = new Map<ResolutionSourceCode, ReadonlySet<ResolutionSourceCode>>([
  ["COINBASE_PRO_USD", new Set<ResolutionSourceCode>()],
  ["COINGECKO_TWAP_1H", new Set<ResolutionSourceCode>()],
  ["KRAKEN_USD", new Set<ResolutionSourceCode>()],
  ["BLS_OFFICIAL", new Set<ResolutionSourceCode>()],
  ["FOMC_OFFICIAL", new Set<ResolutionSourceCode>()],
  ["AP_CALL", new Set<ResolutionSourceCode>()],
  ["OFFICIAL_LEAGUE_SCORE", new Set<ResolutionSourceCode>()],
  ["UMA_PROSE_JUDGMENT", new Set<ResolutionSourceCode>()],
  ["BLOOMBERG_TERMINAL", new Set<ResolutionSourceCode>()],
  ["OTHER", new Set<ResolutionSourceCode>()],
]);

export function areResolutionSourcesCompatible(
  a: ResolutionSourceCode,
  b: ResolutionSourceCode,
): boolean {
  if (a === b) return true;
  return RESOLUTION_COMPATIBILITY.get(a)?.has(b) ?? false;
}

/**
 * Parses `PREDICTION_MARKETS_DETERMINISTIC_SUBJECTS` (CSV). Unknown codes are
 * silently dropped — operators can typo a subject without crashing the scan.
 */
export function parseCutOverSubjects(csv: string): Set<SubjectCode> {
  const out = new Set<SubjectCode>();
  for (const raw of csv.split(",")) {
    const code = raw.trim();
    if (!code) continue;
    if (isSubjectCode(code)) out.add(code);
  }
  return out;
}
