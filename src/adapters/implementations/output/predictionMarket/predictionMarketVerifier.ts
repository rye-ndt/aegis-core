import { createLogger } from "../../../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type { IPolymarketAdapter } from "../../../../use-cases/interface/predictionMarket/IPolymarketAdapter";
import type { IPredictionMarketProvider } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketProvider";
import type {
  IPredictionMarketSizer,
  MarketOrderBook,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketSizer";
import type {
  IPredictionMarketVerifier,
  VerifierContext,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketVerifier";
import type {
  DraftFinding,
  ExpectedRelationship,
  ExpectedRelationshipKind,
  FindingConfidence,
  FindingPatternType,
  RawMarket,
  StoredCluster,
  VerifiedFinding,
} from "../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";

const log = createLogger("predictionMarketVerifier");

const PATTERN_WEIGHT: Record<FindingPatternType, number> = {
  logical_inconsistency: 4,
  term_structure_anomaly: 3,
  implied_contradiction: 2,
  movement_divergence: 2,
  other: 1,
};

const CONFIDENCE_WEIGHT: Record<FindingConfidence, number> = {
  high: 1.0,
  medium: 0.6,
  low: 0.3,
};

// Patterns whose `magnitudeBps` is a real numeric gap and must clear
// `minGapBps`. `other` is a catch-all where a hard gap floor isn't meaningful.
// `implied_contradiction` used to live here as a subjective pass-through, but
// that allowed coherent mutually-exclusive clusters (sum ≈ 100%) to surface
// as "contradictions" with huge `magnitudeBps` values — see false-positive
// post-mortem in the prediction-markets construction notes. The verifier now
// computes magnitude from the cluster's `expectedRelationships.kind` and
// drops sub-threshold findings.
const MIN_GAP_PATTERNS: ReadonlySet<FindingPatternType> = new Set([
  "logical_inconsistency",
  "term_structure_anomaly",
  "movement_divergence",
  "implied_contradiction",
]);

export interface PredictionMarketVerifierConfig {
  provider: IPredictionMarketProvider;
  verifyFreshnessMs: number;
  oddsDriftToleranceBps: number;
  minGapBps: number;
  /** Required deviation from 100% for `mutually_exclusive` clusters. */
  minSumDeviationBps: number;
  findingMinLiquidityUsd: number;
  /** Optional sizing pass. When present, every surviving finding is sized;
   *  uneconomic ones are dropped before they reach the broadcaster. All
   *  fields are required together — "all-or-nothing" is structural. */
  sizing?: {
    sizer: IPredictionMarketSizer;
    polymarket: IPolymarketAdapter;
    /** Polymarket condition_id → CLOB outcome token ids. Returns `null` when
     *  not yet known; the finding then survives un-sized. */
    outcomeTokenIdResolver: (marketId: string) => { yes: string; no: string } | null;
    budgetUsdc: number;
    feeBps: number;
    gasEstimateUsdc: number;
    depthLevels: number;
  };
}

interface CachedQuote {
  market: RawMarket;
  fetchedAt: number;
}

export class PredictionMarketVerifier implements IPredictionMarketVerifier {
  /** Per-instance cache of live re-fetches. TTL = verifyFreshnessMs. */
  private readonly liveCache = new Map<string, CachedQuote>();

  constructor(private readonly cfg: PredictionMarketVerifierConfig) {}

  async verify(ctx: VerifierContext): Promise<VerifiedFinding[]> {
    const { reqId, runId, cluster, snapshotMembers, drafts } = ctx;
    const start = Date.now();
    log.info({ step: "started", reqId, clusterId: cluster.clusterId, drafts: drafts.length }, "verify");

    if (drafts.length === 0) {
      log.info(
        { step: "succeeded", reqId, clusterId: cluster.clusterId, surviving: 0, durationMs: Date.now() - start },
        "verify",
      );
      return [];
    }

    // Collect every market id across drafts; one upstream re-fetch per cluster.
    const idsToFetch = new Set<string>();
    for (const d of drafts) for (const id of d.marketsInvolved) idsToFetch.add(id);
    const liveByMarketId = await this.fetchLive(Array.from(idsToFetch), reqId);

    // Fall back to snapshot for any id the live fetch missed (rare — Polymarket
    // returned the cluster's members in stage 1 already). Snapshot prices are
    // stale but better than dropping the whole finding.
    const snapshotByMarketId = new Map<string, RawMarket>();
    for (const m of snapshotMembers) snapshotByMarketId.set(m.marketId, m);
    const resolveMarket = (id: string): RawMarket | null =>
      liveByMarketId.get(id) ?? snapshotByMarketId.get(id) ?? null;

    const surviving: VerifiedFinding[] = [];
    const nowSec = newCurrentUTCEpoch();
    const clusterMemberIds = new Set(cluster.marketIds);
    // Sizing-outcome tally. Surfaces at `verify.succeeded` so operators can
    // see at a glance whether sizing is actually running or always falling
    // back to skipped/disabled.
    const sizingOutcomes = { disabled: 0, skipped: 0, sized: 0, uneconomic: 0 };

    for (const draft of drafts) {
      const findingId = newUuid();
      const drop = (reason: string) => {
        log.warn(
          { reqId, findingId, clusterId: cluster.clusterId, patternType: draft.patternType, reason },
          "verify drop",
        );
      };

      // Hallucinated id → drop. (Detector already filtered; this is defense in depth.)
      const involved: RawMarket[] = [];
      let hallucinated = false;
      for (const id of draft.marketsInvolved) {
        if (!clusterMemberIds.has(id)) {
          drop("hallucinated-id");
          hallucinated = true;
          break;
        }
        const m = resolveMarket(id);
        if (!m) {
          drop("hallucinated-id");
          hallucinated = true;
          break;
        }
        involved.push(m);
      }
      if (hallucinated) continue;

      // Liquidity floor — every involved market must be tradeable.
      const minLiquidity = involved.reduce(
        (acc, m) => Math.min(acc, m.liquidityUsd),
        Number.POSITIVE_INFINITY,
      );
      if (minLiquidity < this.cfg.findingMinLiquidityUsd) {
        drop("low-liquidity");
        continue;
      }

      // Odds-drift sanity: cited odds must still match live within tolerance.
      let oddsDriftFail = false;
      for (const [id, citedYes] of Object.entries(draft.currentState.citedOdds)) {
        const m = resolveMarket(id);
        if (!m) {
          oddsDriftFail = true;
          break;
        }
        const driftBps = Math.abs(citedYes - m.yesPrice) * 10_000;
        if (driftBps > this.cfg.oddsDriftToleranceBps) {
          oddsDriftFail = true;
          break;
        }
      }
      if (oddsDriftFail) {
        drop("odds-drift");
        continue;
      }

      const liveOdds: Record<string, number> = {};
      for (const m of involved) liveOdds[m.marketId] = m.yesPrice;

      const gap = computeMagnitude(draft, involved, cluster);
      if (gap.kind === "drop") {
        drop(gap.reason);
        continue;
      }

      // Mutually-exclusive clusters use the sum-deviation threshold; everything
      // else uses the generic gap floor.
      const kind = primaryKind(cluster.expectedRelationships);
      const minGap =
        draft.patternType === "implied_contradiction" && kind === "mutually_exclusive"
          ? this.cfg.minSumDeviationBps
          : this.cfg.minGapBps;
      if (MIN_GAP_PATTERNS.has(draft.patternType) && gap.bps < minGap) {
        drop("gap-below-threshold");
        continue;
      }

      const liquidityForRank = Math.max(1, minLiquidity);
      const rankRaw =
        PATTERN_WEIGHT[draft.patternType] *
        CONFIDENCE_WEIGHT[draft.confidence] *
        Math.min(gap.bps / 1000, 1) *
        Math.log10(liquidityForRank);
      const rankScore = Math.max(0, Math.round(rankRaw * 1000));

      const verified: VerifiedFinding = {
        ...draft,
        findingId,
        runId,
        clusterId: cluster.clusterId,
        verifiedAtEpoch: nowSec,
        liveOdds,
        magnitudeBps: gap.bps,
        rankScore,
      };

      const sized = await this.maybeSize(verified, reqId);
      if (sized === "drop-uneconomic") {
        drop("uneconomic");
        sizingOutcomes.uneconomic += 1;
        continue;
      }
      if (sized) {
        verified.sizedTrades = sized.trades;
        verified.expectedProfitUsdc = sized.expectedProfitUsdc;
        verified.minPayoffUsdc = sized.minPayoffUsdc;
        sizingOutcomes.sized += 1;
      } else if (this.cfg.sizing) {
        sizingOutcomes.skipped += 1;
      } else {
        sizingOutcomes.disabled += 1;
      }

      surviving.push(verified);
    }

    log.info(
      {
        step: "succeeded",
        reqId,
        clusterId: cluster.clusterId,
        surviving: surviving.length,
        sizing: sizingOutcomes,
        durationMs: Date.now() - start,
      },
      "verify",
    );
    return surviving;
  }

  /**
   * Returns the sizer output if it succeeded; the literal `'drop-uneconomic'`
   * if the sizer rejected the finding; `null` when sizing is disabled or
   * misconfigured (in which case the finding survives as-is, un-sized).
   */
  private async maybeSize(
    v: VerifiedFinding,
    reqId: string,
  ): Promise<{ trades: VerifiedFinding["sizedTrades"]; expectedProfitUsdc: number; minPayoffUsdc: number } | "drop-uneconomic" | null> {
    const sizing = this.cfg.sizing;
    if (!sizing) return null;
    try {
      const tokenMaps = v.marketsInvolved.map((id) => ({ id, tokens: sizing.outcomeTokenIdResolver(id) }));
      const missingTokenIds = tokenMaps.filter((x) => !x.tokens).map((x) => x.id);
      if (missingTokenIds.length > 0) {
        log.warn(
          { reqId, findingId: v.findingId, missingTokenIds, reason: "tokens-missing" },
          "sizing-skipped",
        );
        return null;
      }
      const fetches = await Promise.all(
        tokenMaps.flatMap(({ id, tokens }) => [
          sizing.polymarket.getOrderbookDepth({ outcomeTokenId: tokens!.yes, side: "BUY", depthLevels: sizing.depthLevels })
            .then((asks) => ({ id, side: "yesAsks" as const, levels: asks })),
          sizing.polymarket.getOrderbookDepth({ outcomeTokenId: tokens!.no, side: "BUY", depthLevels: sizing.depthLevels })
            .then((asks) => ({ id, side: "noAsks" as const, levels: asks })),
        ]),
      );
      const orderBook: Record<string, MarketOrderBook> = {};
      for (const { id } of tokenMaps) orderBook[id] = { yesBids: [], yesAsks: [], noBids: [], noAsks: [] };
      for (const f of fetches) orderBook[f.id]![f.side] = f.levels;
      const sized = await sizing.sizer.size({
        finding: v,
        orderBook,
        budgetUsdc: sizing.budgetUsdc,
        feeBps: sizing.feeBps,
        gasEstimateUsdc: sizing.gasEstimateUsdc,
        reqId,
      });
      if (sized.kind === "uneconomic") return "drop-uneconomic";
      return {
        trades: sized.trades,
        expectedProfitUsdc: sized.expectedProfitUsdc,
        minPayoffUsdc: sized.minPayoffUsdc,
      };
    } catch (err) {
      log.warn({ err, reqId, findingId: v.findingId }, "sizing failed — surviving un-sized");
      return null;
    }
  }

  private async fetchLive(ids: string[], reqId: string): Promise<Map<string, RawMarket>> {
    const out = new Map<string, RawMarket>();
    const now = Date.now();
    // Bounded by topN snapshot, but evict expired entries so weeks of ticks
    // don't accumulate stale rows for markets that have left the universe.
    for (const [id, cached] of this.liveCache) {
      if (now - cached.fetchedAt >= this.cfg.verifyFreshnessMs) this.liveCache.delete(id);
    }
    const stale: string[] = [];
    for (const id of ids) {
      const cached = this.liveCache.get(id);
      if (cached) {
        out.set(id, cached.market);
      } else {
        stale.push(id);
      }
    }
    if (stale.length === 0) {
      log.debug({ reqId, choice: "hit", count: ids.length }, "verify live cache");
      return out;
    }

    try {
      const fresh = await this.cfg.provider.fetchByIds(stale, reqId);
      for (const m of fresh) {
        this.liveCache.set(m.marketId, { market: m, fetchedAt: now });
        out.set(m.marketId, m);
      }
    } catch (err) {
      log.warn({ err, reqId, requested: stale.length }, "verify live fetch failed");
    }
    return out;
  }
}

type GapResult =
  | { kind: "ok"; bps: number }
  | { kind: "drop"; reason: "missing-role-tag" | "wrong-direction" | "pattern-not-violated" };

function directionalGap(
  involved: RawMarket[],
  aId: string | undefined,
  bId: string | undefined,
): GapResult {
  if (!aId || !bId) return { kind: "drop", reason: "missing-role-tag" };
  const a = involved.find((m) => m.marketId === aId);
  const b = involved.find((m) => m.marketId === bId);
  if (!a || !b) return { kind: "drop", reason: "missing-role-tag" };
  const bps = Math.round((a.yesPrice - b.yesPrice) * 10_000);
  if (bps <= 0) return { kind: "drop", reason: "wrong-direction" };
  return { kind: "ok", bps };
}

function computeMagnitude(
  draft: DraftFinding,
  involved: RawMarket[],
  cluster: StoredCluster,
): GapResult {
  const kind = primaryKind(cluster.expectedRelationships);
  switch (draft.patternType) {
    case "logical_inconsistency":
    case "implied_contradiction": {
      if (kind === "mutually_exclusive") {
        return { kind: "ok", bps: sumDeviationBps(involved.map((m) => m.yesPrice)) };
      }
      // Nested: a real inconsistency requires P(narrower) > P(wider) — the
      // subset priced above the superset. Anything else is correct-direction.
      return directionalGap(involved, draft.narrowerMarketId, draft.widerMarketId);
    }
    case "term_structure_anomaly":
      // Earlier-resolving event is a subset of the later (its window sits
      // inside), so P(earlier) ≤ P(later). Violation = P(earlier) > P(later).
      return directionalGap(involved, draft.earlierMarketId, draft.laterMarketId);
    case "movement_divergence": {
      const deltas = involved
        .map((m) => m.priceChange24hBps)
        .filter((d): d is number => typeof d === "number");
      if (deltas.length < 2) return { kind: "drop", reason: "pattern-not-violated" };
      return { kind: "ok", bps: Math.abs(Math.max(...deltas) - Math.min(...deltas)) };
    }
    case "other":
      return { kind: "ok", bps: maxPairwiseGapBps(involved) };
  }
}

export function primaryKind(
  rels: ExpectedRelationship[] | null | undefined,
): ExpectedRelationshipKind | null {
  return rels?.[0]?.kind ?? null;
}

/**
 * For a mutually-exclusive set of YES-priced binaries, the YES probabilities
 * should sum to ≈ 1.0. Returns |sum − 1.0| in bps. A small value (≤300 bps)
 * signals proper pricing — the cluster is in consensus, not contradiction.
 */
export function sumDeviationBps(prices: number[]): number {
  if (prices.length === 0) return 0;
  const sum = prices.reduce((acc, p) => acc + p, 0);
  return Math.round(Math.abs(sum - 1) * 10_000);
}

function maxPairwiseGapBps(markets: RawMarket[]): number {
  let max = 0;
  for (let i = 0; i < markets.length; i += 1) {
    for (let j = i + 1; j < markets.length; j += 1) {
      const gap = Math.abs(markets[i].yesPrice - markets[j].yesPrice) * 10_000;
      if (gap > max) max = gap;
    }
  }
  return Math.round(max);
}
