import { createLogger } from "../../../../helpers/observability/logger";
import {
  partition_exhaustive,
  partition_nonexhaustive,
  subset,
  temporal_nested,
  type Priced,
} from "../../../../use-cases/interface/predictionMarket/relationshipPrimitives";
import type {
  DetectorInput,
  DetectorResult,
  IPredictionMarketDetector,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketDetector";
import type { IPredictionMarketFactRepository } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketFactRepository";
import type { MarketFact } from "../../../../use-cases/interface/predictionMarket/MarketFactTypes";
import {
  formatThreshold,
  numericThreshold,
  opSymbol,
} from "../../../../use-cases/interface/predictionMarket/marketFactFormat";
import type {
  DraftFinding,
  ExpectedRelationshipKind,
  FindingConfidence,
  RawMarket,
  SideThesis,
} from "../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";

const log = createLogger("predictionMarketDeterministicDetector");

export interface DeterministicDetectorConfig {
  /** Tolerance for primitive violations, in bps. Matches LLM verifier minGap. */
  tolBps: number;
  /** Liquidity floor (USD) for `confidence: 'high'`. Below this, all findings
   *  for the cluster are downgraded to `medium`. */
  highConfidenceLiquidityUsd: number;
  /** Magnitude floor (bps) for `confidence: 'high'`. */
  highConfidenceMagnitudeBps: number;
}

export class DeterministicPredictionMarketDetector implements IPredictionMarketDetector {
  constructor(
    private readonly factRepo: IPredictionMarketFactRepository,
    private readonly cfg: DeterministicDetectorConfig,
  ) {}

  // Deterministic detector has no LLM call to cache; `cacheHit` is always
  // false in the returned `DetectorResult` so the scan rollup attributes
  // all hits to the LLM path.
  async detect(input: DetectorInput): Promise<DetectorResult> {
    const { cluster, members, reqId } = input;
    const start = Date.now();

    log.info(
      { step: "detect-deterministic-start", reqId, clusterId: cluster.clusterId, members: members.length },
      "detect",
    );

    if (members.length < 2) {
      log.info(
        { step: "detect-deterministic-end", reqId, clusterId: cluster.clusterId, drafts: 0, mode: "too-few-members", durationMs: Date.now() - start },
        "detect",
      );
      return { drafts: [], cacheHit: false };
    }

    const factById = await this.factRepo.getByMarketIds(members.map((m) => m.marketId));
    const allFactsVerified = members.every((m) => {
      const f = factById.get(m.marketId);
      return !!f && f.regexVerified;
    });
    if (!allFactsVerified) {
      log.warn(
        { reqId, clusterId: cluster.clusterId, mode: "facts-missing-or-unverified" },
        "deterministic detect skipped — cluster will be re-served by LLM next tick",
      );
      return { drafts: [], cacheHit: false };
    }

    const kind: ExpectedRelationshipKind =
      cluster.expectedRelationships[0]?.kind ?? "other";
    const memberById = new Map<string, RawMarket>();
    for (const m of members) memberById.set(m.marketId, m);

    let drafts: DraftFinding[];
    let primitive: string;
    switch (kind) {
      case "nested":
        primitive = "subset";
        drafts = this.detectNested(members, factById);
        break;
      case "term_structure":
        primitive = "temporal_nested";
        drafts = this.detectTermStructure(members, factById);
        break;
      case "mutually_exclusive":
        primitive = "partition";
        drafts = this.detectPartition(members, factById);
        break;
      default:
        primitive = "none";
        drafts = [];
        break;
    }

    log.info(
      {
        step: "detect-deterministic-end",
        reqId,
        clusterId: cluster.clusterId,
        drafts: drafts.length,
        primitive,
        durationMs: Date.now() - start,
      },
      "detect",
    );

    return { drafts, cacheHit: false };
  }

  // Only adjacent pairs after sort — sufficient for transitive relations
  // (P(A)≤P(B) ∧ P(B)≤P(C) ⇒ P(A)≤P(C); any non-adjacent violation implies
  // some adjacent violation). Matches the clusterer's `buildRelationships`.
  private detectNested(members: RawMarket[], factById: Map<string, MarketFact>): DraftFinding[] {
    const sorted = members
      .map((m) => ({ m, fact: factById.get(m.marketId)!, n: numericThreshold(factById.get(m.marketId)!) }))
      .filter((x): x is { m: RawMarket; fact: MarketFact; n: number } => x.n !== null)
      .sort((a, b) => a.n - b.n);

    const op = sorted[0]?.fact.operator;
    if (!op) return [];
    const narrowerIsHigher = op === "gte" || op === "gt";

    const drafts: DraftFinding[] = [];
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      const wider = narrowerIsHigher ? a : b;
      const narrower = narrowerIsHigher ? b : a;
      const result = subset({
        wider: priced(wider.m),
        narrower: priced(narrower.m),
        tolBps: this.cfg.tolBps,
      });
      if (!result) continue;
      drafts.push(this.buildSubsetFinding(wider.m, narrower.m, wider.fact, narrower.fact, result.violationBps, members));
    }
    return drafts;
  }

  private detectTermStructure(members: RawMarket[], factById: Map<string, MarketFact>): DraftFinding[] {
    const sorted = members
      .map((m) => ({ m, fact: factById.get(m.marketId)! }))
      .sort((a, b) => a.fact.windowEnd - b.fact.windowEnd);
    const drafts: DraftFinding[] = [];
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const earlier = sorted[i]!;
      const later = sorted[i + 1]!;
      const result = temporal_nested({
        earlier: priced(earlier.m),
        later: priced(later.m),
        tolBps: this.cfg.tolBps,
      });
      if (!result) continue;
      drafts.push(this.buildTermStructureFinding(earlier.m, later.m, earlier.fact, later.fact, result.violationBps, members));
    }
    return drafts;
  }

  private detectPartition(members: RawMarket[], factById: Map<string, MarketFact>): DraftFinding[] {
    // Facts don't carry exhaustiveness today; non-exhaustive primitive is
    // strictly safer (allows under-pricing) and the verifier re-checks
    // sum-deviation downstream.
    const pricedMembers = members.map((m) => ({ marketId: m.marketId, yesPrice: m.yesPrice }));
    const exhaustive = partition_exhaustive({ members: pricedMembers, tolBps: this.cfg.tolBps });
    const result = exhaustive ?? partition_nonexhaustive({ members: pricedMembers, tolBps: this.cfg.tolBps });
    if (!result) return [];

    // Top-2 by liquidity is a stopgap; Part 6's sizer is authoritative.
    const sortedByLiq = [...members].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    const a = sortedByLiq[0]!;
    const b = sortedByLiq[1] ?? sortedByLiq[0]!;
    const factA = factById.get(a.marketId)!;
    const sum = pricedMembers.reduce((acc, p) => acc + p.yesPrice, 0);
    const rationale = `Σ P(${factA.subject} ∈ ...) = ${pct(sum)} (target ≤ 100%) — mutually-exclusive cluster over-prices by ${result.violationBps} bps.`;
    const confidence = bucketConfidence(result.violationBps, members, this.cfg);
    return [
      {
        patternType: "logical_inconsistency",
        marketsInvolved: members.map((m) => m.marketId),
        currentState: { citedOdds: Object.fromEntries(members.map((m) => [m.marketId, m.yesPrice])) },
        whyAnomalous: `Mutually-exclusive YES prices sum to ${pct(sum)} — exceeds 100% by ${result.violationBps} bps.`,
        sideA: buildSide(a, "NO", "sell over-priced YES"),
        sideB: buildSide(b, "NO", "sell over-priced YES"),
        confidence,
        rationale,
      },
    ];
  }

  private buildSubsetFinding(
    wider: RawMarket,
    narrower: RawMarket,
    widerFact: MarketFact,
    narrowerFact: MarketFact,
    violationBps: number,
    allMembers: RawMarket[],
  ): DraftFinding {
    const rationale = `P(${widerFact.subject} ${opSymbol(widerFact.operator)} ${formatThreshold(widerFact)}) = ${pct(wider.yesPrice)} but P(${narrowerFact.subject} ${opSymbol(narrowerFact.operator)} ${formatThreshold(narrowerFact)}) = ${pct(narrower.yesPrice)} — the wider event is priced below the narrower (violation ${violationBps} bps).`;
    return {
      patternType: "logical_inconsistency",
      marketsInvolved: [wider.marketId, narrower.marketId],
      currentState: { citedOdds: Object.fromEntries(allMembers.map((m) => [m.marketId, m.yesPrice])) },
      whyAnomalous: `P(wider) < P(narrower) by ${violationBps} bps — structurally impossible.`,
      sideA: buildSide(wider, "YES", "buy under-priced wider event"),
      sideB: buildSide(narrower, "NO", "sell over-priced narrower event"),
      confidence: bucketConfidence(violationBps, [wider, narrower], this.cfg),
      rationale,
      widerMarketId: wider.marketId,
      narrowerMarketId: narrower.marketId,
    };
  }

  private buildTermStructureFinding(
    earlier: RawMarket,
    later: RawMarket,
    earlierFact: MarketFact,
    laterFact: MarketFact,
    violationBps: number,
    allMembers: RawMarket[],
  ): DraftFinding {
    const rationale = `P(${earlierFact.subject} by ${earlierFact.windowEnd}) = ${pct(earlier.yesPrice)} but P(${laterFact.subject} by ${laterFact.windowEnd}) = ${pct(later.yesPrice)} — earlier window cannot exceed later (violation ${violationBps} bps).`;
    return {
      patternType: "term_structure_anomaly",
      marketsInvolved: [earlier.marketId, later.marketId],
      currentState: { citedOdds: Object.fromEntries(allMembers.map((m) => [m.marketId, m.yesPrice])) },
      whyAnomalous: `Earlier window priced above later window by ${violationBps} bps — temporal inversion.`,
      sideA: buildSide(later, "YES", "buy under-priced later window"),
      sideB: buildSide(earlier, "NO", "sell over-priced earlier window"),
      confidence: bucketConfidence(violationBps, [earlier, later], this.cfg),
      rationale,
      earlierMarketId: earlier.marketId,
      laterMarketId: later.marketId,
    };
  }
}

function priced(m: RawMarket): Priced {
  return { marketId: m.marketId, yesPrice: m.yesPrice };
}

function pct(p: number): string {
  return `${Math.round(p * 1000) / 10}%`;
}

function bucketConfidence(
  magnitudeBps: number,
  involved: RawMarket[],
  cfg: DeterministicDetectorConfig,
): FindingConfidence {
  const minLiq = involved.reduce((acc, m) => Math.min(acc, m.liquidityUsd), Infinity);
  if (
    magnitudeBps > cfg.highConfidenceMagnitudeBps &&
    minLiq > cfg.highConfidenceLiquidityUsd
  ) {
    return "high";
  }
  return "medium";
}

function buildSide(m: RawMarket, outcome: "YES" | "NO", rationale: string): SideThesis {
  const q = m.question.slice(0, 40);
  const label = `${outcome} ${q}`.slice(0, 60);
  return { label, marketId: m.marketId, outcome, rationale };
}
