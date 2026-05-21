import { LRUCache } from "lru-cache";
import { createLogger } from "../../../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type { IPolymarketReadAdapter } from "../../../../use-cases/interface/predictionMarket/IPolymarketAdapter";
import type {
  IPredictionMarketProvider,
  OutcomeTokenPair,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketProvider";
import type { IPredictionMarketSizer } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketSizer";
import type {
  IPredictionMarketVerifier,
  VerifierContext,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketVerifier";
import type {
  DraftFinding,
  RawMarket,
  StoredCluster,
  VerifiedFinding,
} from "../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";

const log = createLogger("predictionMarketVerifier");

const PATTERN_WEIGHT: Record<DraftFinding["patternType"], number> = {
  logical_inconsistency: 4,
  term_structure_anomaly: 3,
  implied_contradiction: 2,
  movement_divergence: 2,
  other: 1,
};

const CONFIDENCE_WEIGHT: Record<DraftFinding["confidence"], number> = {
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
const MIN_GAP_PATTERNS: Set<DraftFinding["patternType"]> = new Set([
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
  minSumDeviationBps: number;
  findingMinLiquidityUsd: number;
  /**
   * Optional Phase 5 LP sizing — wired through DI when
   * `PREDICTION_MARKETS_ENV.sizingEnabled` is on. Not consumed by `verify()`
   * directly today; the integration point is `maybeSize()` (deferred). When
   * absent, verified findings ship without `sizedTrades` populated.
   */
  sizing?: {
    sizer: IPredictionMarketSizer;
    polymarket: IPolymarketReadAdapter;
    outcomeTokenIdResolver: (marketId: string) => OutcomeTokenPair | null;
    budgetUsdc: number;
    feeBps: number;
    gasEstimateUsdc: number;
    depthLevels: number;
  };
}

export class PredictionMarketVerifier implements IPredictionMarketVerifier {
  /**
   * Per-instance cache of live re-fetches. TTL = verifyFreshnessMs.
   * Bounded by `max` so a burst of unique market ids can't grow the cache
   * unboundedly between ticks.
   */
  private readonly liveCache: LRUCache<string, RawMarket>;

  constructor(private readonly cfg: PredictionMarketVerifierConfig) {
    this.liveCache = new LRUCache({
      max: 1_000,
      ttl: cfg.verifyFreshnessMs,
    });
  }

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

      // Pattern + cluster-kind-aware magnitude. `null` means the alleged
      // pattern no longer holds (e.g. mutually-exclusive cluster sums to
      // 100%, monotonic term structure restored).
      const gapResult = computeMagnitude(draft, involved, cluster);
      if (gapResult === null) {
        drop("pattern-not-violated");
        continue;
      }

      // Pattern-specific minimum gap. Mutually-exclusive clusters use the
      // sum-deviation threshold; everything else uses the generic gap floor.
      const kind = primaryKind(cluster);
      const minGap =
        draft.patternType === "implied_contradiction" && kind === "mutually_exclusive"
          ? this.cfg.minSumDeviationBps
          : this.cfg.minGapBps;
      if (MIN_GAP_PATTERNS.has(draft.patternType) && gapResult < minGap) {
        drop("gap-below-threshold");
        continue;
      }

      const liquidityForRank = Math.max(1, minLiquidity);
      const rankRaw =
        PATTERN_WEIGHT[draft.patternType] *
        CONFIDENCE_WEIGHT[draft.confidence] *
        Math.min(gapResult / 1000, 1) *
        Math.log10(liquidityForRank);
      const rankScore = Math.max(0, Math.round(rankRaw * 1000));

      surviving.push({
        ...draft,
        findingId,
        runId,
        clusterId: cluster.clusterId,
        verifiedAtEpoch: nowSec,
        liveOdds,
        magnitudeBps: Math.round(gapResult),
        rankScore,
      });
    }

    log.info(
      { step: "succeeded", reqId, clusterId: cluster.clusterId, surviving: surviving.length, durationMs: Date.now() - start },
      "verify",
    );
    return surviving;
  }

  private async fetchLive(ids: string[], reqId: string): Promise<Map<string, RawMarket>> {
    const out = new Map<string, RawMarket>();
    const stale: string[] = [];
    for (const id of ids) {
      const cached = this.liveCache.get(id);
      if (cached) {
        out.set(id, cached);
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
        this.liveCache.set(m.marketId, m);
        out.set(m.marketId, m);
      }
    } catch (err) {
      log.warn({ err, reqId, requested: stale.length }, "verify live fetch failed");
    }
    return out;
  }
}

function computeMagnitude(
  draft: DraftFinding,
  involved: RawMarket[],
  cluster: StoredCluster,
): number | null {
  const kind = primaryKind(cluster);
  switch (draft.patternType) {
    case "logical_inconsistency": {
      // For mutually-exclusive or nested clusters, an inconsistency means
      // the implied probabilities violate the structural constraint — sum
      // far from 100% (mutually-exclusive) or narrower priced above wider
      // (nested). Without explicit pair-of-markets metadata from the LLM we
      // approximate via sum-deviation for mutually-exclusive and pairwise
      // gap otherwise.
      if (kind === "mutually_exclusive") {
        return sumDeviationBps(involved);
      }
      return maxPairwiseGapBps(involved);
    }
    case "term_structure_anomaly": {
      // A real term-structure anomaly only exists when an earlier-resolving
      // event is priced strictly above a later-resolving event covering the
      // same underlying outcome. The wider window contains the narrower, so
      // P(narrower) ≤ P(wider) is the structural constraint; pure presence
      // of a price gap is not enough — it can be in the *correct* direction
      // (e.g. "deal by May 15" 17% < "deal by May 31" 28% is healthy, not
      // an anomaly).
      //
      // We sort by resolutionEpochSec and look for any pair where the
      // earlier market's yesPrice strictly exceeds a later market's. The
      // worst such violation in bps is the magnitude. If every earlier
      // market is priced ≤ every later market, return null → drop with
      // `pattern-not-violated`.
      const sorted = [...involved].sort(
        (a, b) => a.resolutionEpochSec - b.resolutionEpochSec,
      );
      let worstViolationBps = 0;
      for (let i = 0; i < sorted.length - 1; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          const violation = sorted[i]!.yesPrice - sorted[j]!.yesPrice;
          if (violation > 0) {
            const bps = Math.round(violation * 10_000);
            if (bps > worstViolationBps) worstViolationBps = bps;
          }
        }
      }
      return worstViolationBps > 0 ? worstViolationBps : null;
    }
    case "movement_divergence": {
      const deltas = involved
        .map((m) => m.priceChange24hBps)
        .filter((d): d is number => typeof d === "number");
      if (deltas.length < 2) return null;
      return Math.abs(Math.max(...deltas) - Math.min(...deltas));
    }
    case "implied_contradiction": {
      // Mutually-exclusive clusters: a "contradiction" only exists if the
      // probabilities don't sum to ~100%. Wide pairwise spreads (96/3/0) are
      // CONSENSUS, not contradiction — drop with sum-near-100 returning a
      // small magnitude that fails the minSumDeviationBps gate.
      if (kind === "mutually_exclusive") {
        return sumDeviationBps(involved);
      }
      // Nested: contradiction means the narrower event is priced higher than
      // the wider one. Without pairwise metadata, fall back to pairwise gap;
      // the LLM's rationale + odds-drift check are the primary safeguards.
      const gap = maxPairwiseGapBps(involved);
      return gap > 0 ? gap : null;
    }
    case "other":
      return maxPairwiseGapBps(involved);
  }
}

function primaryKind(cluster: StoredCluster): string | null {
  return cluster.expectedRelationships[0]?.kind ?? null;
}

/**
 * For a mutually-exclusive set of YES-priced binaries, the YES probabilities
 * should sum to ≈ 1.0. Returns |sum − 1.0| in bps. A small value (≤300 bps)
 * signals proper pricing — the cluster is in consensus, not contradiction.
 */
function sumDeviationBps(markets: RawMarket[]): number {
  if (markets.length === 0) return 0;
  const sum = markets.reduce((acc, m) => acc + m.yesPrice, 0);
  return Math.round(Math.abs(sum - 1) * 10_000);
}

function maxPairwiseGapBps(markets: RawMarket[]): number {
  let max = 0;
  for (let i = 0; i < markets.length; i += 1) {
    for (let j = i + 1; j < markets.length; j += 1) {
      const gap = Math.abs(markets[i]!.yesPrice - markets[j]!.yesPrice) * 10_000;
      if (gap > max) max = gap;
    }
  }
  return Math.round(max);
}
