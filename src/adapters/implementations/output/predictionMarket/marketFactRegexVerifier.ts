/**
 * Pure regex verifier for `MarketFact`. Phase 2 of the deterministic-detection
 * plan (`constructions/2026-05-11-prediction-markets-deterministic-detection-part3.md`).
 * No external calls. Caller routes verified facts to `prediction_market_facts`
 * and unverified ones to `prediction_market_extraction_reviews`.
 */
import type { Operator, MarketFact } from "../../../../use-cases/interface/predictionMarket/MarketFactTypes";
import {
  RESOLUTION_SOURCE_SET,
  SUBJECT_SET,
} from "../../../../use-cases/interface/predictionMarket/marketFactVocabularies";
import type { RawMarket } from "../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";

export interface VerifyFailure {
  field: string;
  reason: string;
}

export type VerifyResult = { ok: true } | { ok: false; failures: VerifyFailure[] };

const WINDOW_TOL_SEC = 24 * 60 * 60;

// Why: `\bis\b` and `\bwhich\b` matched almost any English market title and
// effectively turned the `eq`/`in` keyword check into a no-op. The remaining
// keywords are anchored to operator semantics; if none match the criteria,
// the proposal goes to review.
//
// `eq` 2026-05-20 expansion: original `equal|exactly|==` was too narrow.
// The LLM correctly emits `op: eq` for both "stays at value X" framings
// (e.g. "no change in Fed rates") and "X wins the championship" framings.
// `becomes`/`named` were considered but would fire on too much unrelated
// English — added only the patterns observed in the failing review queue.
const OPERATOR_KEYWORDS: Record<Operator, RegExp[]> = {
  gte: [/\breach(?:es|ed)?\b/, /\bhit(?:s|ting)?\b/, /\babove\b/, /\bat least\b/, /≥/, />=/],
  gt: [/(?<![<>=])>(?![=])/, /\bmore than\b/, /\bexceed(?:s|ed)?\b/, /\bover\b/],
  lte: [/\bbelow\b/, /\bunder\b/, /\bat most\b/, /≤/, /<=/, /\bno (?:more|higher) than\b/],
  lt: [/(?<![<>=])<(?![=])/, /\bless than\b/, /\bbelow\b/],
  eq: [
    /\bequal(?:s|ed)?\b/,
    /\bexactly\b/,
    /==/,
    /\bno change\b/,
    /\bunchanged\b/,
    /\bstays?\b/,
    /\bremains?\b/,
    /\bholds? at\b/,
    /\bwin(?:s|ning)?\b/,
  ],
  in: [/\bone of\b/, /\bany of\b/, /\bbetween\b/, /\bamong\b/, /\bfrom the (?:set|list)\b/],
};

const RESOLUTION_SOURCE_ALIASES: Partial<Record<string, RegExp[]>> = {
  COINBASE_PRO_USD: [/coinbase/i],
  COINGECKO_TWAP_1H: [/coingecko/i, /twap/i],
  KRAKEN_USD: [/kraken/i],
  BLS_OFFICIAL: [/\bbls\b/i, /bureau of labor/i],
  FOMC_OFFICIAL: [/\bfomc\b/i, /federal open market/i, /federal reserve/i],
  AP_CALL: [/\bap\b/, /associated press/i],
  // Intentionally a soft check: this alias list is the LAST line of defence
  // for `resolutionSource = OFFICIAL_LEAGUE_SCORE`, and broad patterns
  // (`\bfinals?\b`, `championship`) subsume most of the league-specific
  // anchors below. That's by design — the LLM only picks
  // OFFICIAL_LEAGUE_SCORE for sports markets, so the discriminating signal
  // is the source pick itself, not this alias check. The narrow anchors
  // stay as readability hints for future maintainers expanding the list.
  // Pre-2026-05-20 baseline was `/official.*score/i, /league.*office/i`
  // which matched almost no real criteria — the failure was being too
  // strict, not too permissive.
  OFFICIAL_LEAGUE_SCORE: [
    /\bnba\b/i,
    /\bnfl\b/i,
    /\bnhl\b/i,
    /\bmlb\b/i,
    /\bipl\b/i,
    /\bepl\b/i,
    /\buefa\b/i,
    /\bfifa\b/i,
    /premier.league/i,
    /champions.league/i,
    /super.bowl/i,
    /stanley.cup/i,
    /\bfinals?\b/i,
    /world.cup/i,
    /championship/i,
    /official.*score/i,
    /league.*office/i,
  ],
  UMA_PROSE_JUDGMENT: [/\buma\b/i, /optimistic oracle/i],
  BLOOMBERG_TERMINAL: [/bloomberg/i],
};

function corpusFor(market: RawMarket): string {
  return `${market.question}\n${market.resolutionCriteria}`;
}

function expandNumericVariants(n: number): string[] {
  const variants = new Set<string>();
  variants.add(String(n));
  if (Number.isInteger(n)) {
    variants.add(n.toLocaleString("en-US"));
    if (n >= 1000) {
      const kRaw = n / 1000;
      const kStr = kRaw % 1 === 0 ? kRaw.toFixed(0) : kRaw.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
      variants.add(`${kStr}k`);
      variants.add(`${kStr}K`);
    }
    if (n >= 1_000_000) {
      const mRaw = n / 1_000_000;
      const mStr = mRaw % 1 === 0 ? mRaw.toFixed(0) : mRaw.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
      variants.add(`${mStr}m`);
      variants.add(`${mStr}M`);
    }
    if (n >= 1_000_000_000) {
      const bRaw = n / 1_000_000_000;
      const bStr = bRaw % 1 === 0 ? bRaw.toFixed(0) : bRaw.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
      variants.add(`${bStr}bn`);
      variants.add(`${bStr}B`);
      variants.add(`${bStr}b`);
    }
  } else {
    variants.add(n.toFixed(2));
    variants.add(n.toFixed(1));
  }
  return Array.from(variants);
}

function corpusContainsNumeric(corpus: string, threshold: number | string): boolean {
  if (typeof threshold === "number") {
    return expandNumericVariants(threshold).some((v) => corpus.includes(v));
  }
  // Numeric-shaped string: try parsing; fall through to substring.
  const asNum = Number(String(threshold).replace(/[,_$\s]|usd/gi, ""));
  if (Number.isFinite(asNum)) {
    return expandNumericVariants(asNum).some((v) => corpus.includes(v));
  }
  return corpus.toLowerCase().includes(String(threshold).toLowerCase());
}

export function verifyFact(args: {
  market: RawMarket;
  proposed: MarketFact;
}): VerifyResult {
  const { market, proposed } = args;
  const failures: VerifyFailure[] = [];
  const corpus = corpusFor(market);
  const corpusLower = corpus.toLowerCase();

  // ---- subject ------------------------------------------------------------
  if (!SUBJECT_SET.has(proposed.subject)) {
    failures.push({ field: "subject", reason: `not in SUBJECTS (${proposed.subject})` });
  } else if (proposed.subject === "OTHER") {
    failures.push({ field: "subject", reason: "OTHER forces review" });
  }

  // ---- threshold / thresholdSet ------------------------------------------
  if (proposed.operator === "in") {
    if (!proposed.thresholdSet || proposed.thresholdSet.length === 0) {
      failures.push({ field: "thresholdSet", reason: "operator='in' requires non-empty thresholdSet" });
    } else {
      const missing = proposed.thresholdSet.filter(
        (s) => !corpusLower.includes(s.toLowerCase()),
      );
      if (missing.length > 0) {
        failures.push({
          field: "thresholdSet",
          reason: `missing substring(s): ${missing.join(", ")}`,
        });
      }
    }
  } else {
    if (proposed.threshold === null || proposed.threshold === undefined) {
      failures.push({ field: "threshold", reason: "required for non-'in' operator" });
    } else if (!corpusContainsNumeric(corpus, proposed.threshold)) {
      failures.push({
        field: "threshold",
        reason: `no match for ${proposed.threshold} in title/criteria`,
      });
    }
  }

  // ---- windowEnd ---------------------------------------------------------
  if (Math.abs(proposed.windowEnd - market.resolutionEpochSec) > WINDOW_TOL_SEC) {
    failures.push({
      field: "windowEnd",
      reason: `${proposed.windowEnd} vs market.resolutionEpochSec=${market.resolutionEpochSec} differ by >${WINDOW_TOL_SEC}s`,
    });
  }

  // ---- operator ----------------------------------------------------------
  const opKeywords = OPERATOR_KEYWORDS[proposed.operator];
  if (!opKeywords) {
    failures.push({ field: "operator", reason: `unknown operator ${proposed.operator}` });
  } else if (!opKeywords.some((re) => re.test(corpusLower))) {
    failures.push({
      field: "operator",
      reason: `no keyword for operator='${proposed.operator}' in title/criteria`,
    });
  }

  // ---- resolutionSource --------------------------------------------------
  if (!RESOLUTION_SOURCE_SET.has(proposed.resolutionSource)) {
    failures.push({
      field: "resolutionSource",
      reason: `not in RESOLUTION_SOURCES (${proposed.resolutionSource})`,
    });
  } else if (proposed.resolutionSource !== "OTHER") {
    const aliases = RESOLUTION_SOURCE_ALIASES[proposed.resolutionSource];
    if (aliases && !aliases.some((re) => re.test(corpus))) {
      failures.push({
        field: "resolutionSource",
        reason: `no alias for ${proposed.resolutionSource} in criteria`,
      });
    }
  }

  // ---- polymarketEventId -------------------------------------------------
  if (proposed.polymarketEventId !== null && market.polymarketEventId !== null && market.polymarketEventId !== undefined) {
    if (proposed.polymarketEventId !== market.polymarketEventId) {
      failures.push({
        field: "polymarketEventId",
        reason: `proposed=${proposed.polymarketEventId} vs gamma=${market.polymarketEventId}`,
      });
    }
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}
