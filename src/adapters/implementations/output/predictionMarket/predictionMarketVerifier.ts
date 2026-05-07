import { createLogger } from "../../../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type { IPredictionMarketProvider } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketProvider";
import type {
  IPredictionMarketVerifier,
  VerifierContext,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketVerifier";
import type {
  DraftFinding,
  FindingConfidence,
  FindingPatternType,
  RawMarket,
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

// Patterns whose `magnitudeBps` is a real numeric gap and must clear `minGapBps`.
// `implied_contradiction` is subjective (verifier only re-checks odds drift);
// `other` is a catch-all where a hard gap floor isn't meaningful.
const MIN_GAP_PATTERNS: ReadonlySet<FindingPatternType> = new Set([
  "logical_inconsistency",
  "term_structure_anomaly",
  "movement_divergence",
]);

export interface PredictionMarketVerifierConfig {
  provider: IPredictionMarketProvider;
  verifyFreshnessMs: number;
  oddsDriftToleranceBps: number;
  minGapBps: number;
  findingMinLiquidityUsd: number;
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

      // Pattern-specific gap check + magnitude.
      const gapResult = computeMagnitude(draft, involved, liveOdds);
      if (gapResult === null) {
        drop("gap-closed");
        continue;
      }

      if (MIN_GAP_PATTERNS.has(draft.patternType) && gapResult < this.cfg.minGapBps) {
        drop("gap-closed");
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

function computeMagnitude(
  draft: DraftFinding,
  involved: RawMarket[],
  liveOdds: Record<string, number>,
): number | null {
  switch (draft.patternType) {
    case "logical_inconsistency": {
      // Without a fully formal inequality from the LLM we treat the maximum
      // pairwise gap among involved markets as the inequality "violation". If
      // every market is now near-equal the inequality is no longer broken in
      // a meaningful way — return null so the caller drops the finding.
      const gap = maxPairwiseGapBps(involved);
      return gap;
    }
    case "term_structure_anomaly": {
      return maxPairwiseGapBps(involved);
    }
    case "movement_divergence": {
      const deltas = involved
        .map((m) => m.priceChange24hBps)
        .filter((d): d is number => typeof d === "number");
      if (deltas.length < 2) return null;
      return Math.abs(Math.max(...deltas) - Math.min(...deltas));
    }
    case "implied_contradiction": {
      // No further math check (subjective). Use max pairwise gap as proxy and
      // require non-zero so a fully-flat cluster doesn't synthesize signal.
      const gap = maxPairwiseGapBps(involved);
      return gap > 0 ? gap : null;
    }
    case "other":
      return maxPairwiseGapBps(involved);
  }
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
