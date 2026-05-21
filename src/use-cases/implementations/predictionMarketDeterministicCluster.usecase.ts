import { createLogger } from "../../helpers/observability/logger";
import {
  canonicalEventFamily,
  type MarketFact,
} from "../interface/predictionMarket/MarketFactTypes";
import {
  formatThreshold,
  numericThreshold,
  opSymbol,
} from "../interface/predictionMarket/marketFactFormat";
import {
  areResolutionSourcesCompatible,
  type SubjectCode,
} from "../interface/predictionMarket/marketFactVocabularies";
import type {
  DraftCluster,
  ExpectedRelationship,
  ExpectedRelationshipKind,
  RawMarket,
} from "../interface/predictionMarket/PredictionMarketTypes";
import type { IPredictionMarketFactRepository } from "../interface/predictionMarket/IPredictionMarketFactRepository";

const log = createLogger("predictionMarketDeterministicCluster");

const MIN_CLUSTER_MEMBERS = 3;

export interface DeterministicClusterArgs {
  runId: string;
  universe: RawMarket[];
  /** When empty, no fact-based clusters are emitted (production-safe default).
   *  Shadow mode bypasses this filter via `shadowMode`. Independent of
   *  `eventIdFirst` — the event_id pass runs without facts. */
  cutOverSubjects: Set<SubjectCode>;
  reqId: string;
  /** Shadow mode runs the fact-based algorithm over the entire universe
   *  regardless of cut-over subject membership. Output is meant for
   *  `prediction_market_clusters_shadow`, never the live clusters table. */
  shadowMode?: boolean;
  /** Optional pre-fetched facts — supplied by the scan to avoid a second
   *  `getByMarketIds` round-trip when both the production and shadow calls
   *  cover the same universe. */
  factsByMarketId?: Map<string, MarketFact>;
  /** Phase C: when true, group markets sharing a Polymarket `event_id`
   *  into `mutually_exclusive` clusters BEFORE the fact-based pass.
   *  Markets consumed by the event_id pass do not enter the fact-based
   *  pass or the LLM classifier. Off by default. */
  eventIdFirst?: boolean;
}

export interface DeterministicClusterResult {
  deterministic: DraftCluster[];
  /** Markets that did NOT land in any deterministic cluster — feed to LLM. */
  llmEligible: RawMarket[];
}

export class PredictionMarketDeterministicClusterUseCase {
  constructor(private readonly factRepo: IPredictionMarketFactRepository) {}

  async cluster(args: DeterministicClusterArgs): Promise<DeterministicClusterResult> {
    const { runId, universe, cutOverSubjects, reqId, shadowMode = false, factsByMarketId, eventIdFirst = false } = args;
    log.info(
      {
        step: "cluster-deterministic-start",
        reqId,
        runId,
        universeSize: universe.length,
        cutOverSubjects: Array.from(cutOverSubjects),
        shadowMode,
        eventIdFirst,
      },
      "cluster",
    );

    if (universe.length === 0) {
      log.info(
        { step: "cluster-deterministic-end", reqId, runId, deterministic: 0, llmEligible: 0 },
        "cluster",
      );
      return { deterministic: [], llmEligible: [] };
    }

    const deterministic: DraftCluster[] = [];
    const usedMarketIds = new Set<string>();
    let eventIdClusters = 0;

    if (eventIdFirst) {
      // Phase C: trust Polymarket's `event_id` grouping as a structural
      // partition. ≥3-market events are emitted as `mutually_exclusive`
      // without consulting facts; 2-market events fall through so the LLM
      // can still cluster them with cross-event siblings if warranted.
      const byEventId = new Map<string, RawMarket[]>();
      for (const m of universe) {
        const id = m.polymarketEventId;
        if (!id) continue;
        const bucket = byEventId.get(id) ?? [];
        bucket.push(m);
        byEventId.set(id, bucket);
      }
      for (const [eventId, members] of byEventId) {
        if (members.length < MIN_CLUSTER_MEMBERS) continue;
        deterministic.push(buildEventIdCluster(eventId, members));
        for (const m of members) usedMarketIds.add(m.marketId);
        eventIdClusters += 1;
      }
    }

    // Skip the fact-based pass (and the DB fetch for facts) when we know it
    // will emit nothing: no cut-over subjects active AND not in shadow.
    const factBasedActive = shadowMode || cutOverSubjects.size > 0;
    if (!factBasedActive) {
      const llmEligible = universe.filter((m) => !usedMarketIds.has(m.marketId));
      log.info(
        { step: "cluster-deterministic-end", reqId, runId, deterministic: deterministic.length, eventIdClusters, factBasedClusters: 0, llmEligible: llmEligible.length, shadowMode, eventIdFirst },
        "cluster",
      );
      return { deterministic, llmEligible };
    }

    const factUniverse = universe.filter((m) => !usedMarketIds.has(m.marketId));
    const factById = factsByMarketId
      ?? (await this.factRepo.getByMarketIds(factUniverse.map((m) => m.marketId)));

    const byEvent = new Map<string, Map<string, Member[]>>();
    for (const m of factUniverse) {
      const fact = factById.get(m.marketId);
      if (!fact || !fact.regexVerified) continue;
      if (fact.subject === "OTHER") continue;
      if (!shadowMode && !cutOverSubjects.has(fact.subject)) continue;
      const eventKey = fact.polymarketEventId ?? `__no_event__::${fact.eventFamily}`;
      const familyKey = canonicalEventFamily(fact);
      let families = byEvent.get(eventKey);
      if (!families) {
        families = new Map();
        byEvent.set(eventKey, families);
      }
      const bucket = families.get(familyKey) ?? [];
      bucket.push({ market: m, fact });
      families.set(familyKey, bucket);
    }

    for (const [, families] of byEvent) {
      for (const [familyKey, members] of families) {
        if (members.length < MIN_CLUSTER_MEMBERS) continue;
        if (!sourcesPairwiseCompatible(members)) {
          log.debug(
            { reqId, runId, familyKey, members: members.length },
            "deterministic-drop-incompatible-sources",
          );
          continue;
        }
        const subjects = new Set(members.map((x) => x.fact.subject));
        if (subjects.size !== 1) {
          log.debug({ reqId, runId, familyKey }, "deterministic-drop-mixed-subjects");
          continue;
        }
        const subject = members[0]!.fact.subject;
        const kind = pickKind(members);
        // `co_moving` has no deterministic primitive yet. Letting these
        // clusters land in `deterministic[]` would route them to the
        // deterministic detector, which always returns [] — the cluster
        // would be silent forever. Instead, drop the bucket so its members
        // fall through to `llmEligible` and the LLM classifier can group
        // them under whatever causal narrative it sees.
        if (kind === "co_moving") {
          log.debug(
            { reqId, runId, familyKey, members: members.length },
            "deterministic-drop-co-moving",
          );
          continue;
        }
        const cluster = buildCluster(subject, members, kind);
        deterministic.push(cluster);
        for (const x of members) usedMarketIds.add(x.market.marketId);
      }
    }

    const llmEligible = universe.filter((m) => !usedMarketIds.has(m.marketId));

    log.info(
      {
        step: "cluster-deterministic-end",
        reqId,
        runId,
        deterministic: deterministic.length,
        eventIdClusters,
        factBasedClusters: deterministic.length - eventIdClusters,
        llmEligible: llmEligible.length,
        shadowMode,
        eventIdFirst,
      },
      "cluster",
    );

    return { deterministic, llmEligible };
  }
}

function buildEventIdCluster(eventId: string, members: RawMarket[]): DraftCluster {
  const marketIds = members.map((m) => m.marketId).sort();
  return {
    // Human-readable theme for broadcaster UI; causalDriver keeps the
    // structural identifier so downstream code can map back to the event.
    theme: `Polymarket event ${eventId}`,
    causalDriver: `polymarket-event:${eventId}`,
    marketIds,
    expectedRelationships: [
      {
        kind: "mutually_exclusive",
        description: `Σ P(market ∈ polymarket-event:${eventId}) ≤ 1`,
      },
    ],
    rationale:
      "Deterministic cluster from Polymarket event_id grouping (same event = mutually-exclusive partition).",
    // Polymarket's structural grouping is a stronger signal than the LLM's
    // inferred causal driver; we trust it as `high`.
    confidence: "high",
    // No `derivedSubject` — event_id clusters bypass the fact pipeline, so
    // `pickDetector` routes them to the LLM detector (subject-based
    // deterministic detection requires a `MarketFact.subject` match).
    derivedSubject: null,
  };
}

function sourcesPairwiseCompatible(members: { fact: MarketFact }[]): boolean {
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      if (
        !areResolutionSourcesCompatible(
          members[i]!.fact.resolutionSource,
          members[j]!.fact.resolutionSource,
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

type Member = { market: RawMarket; fact: MarketFact };

function pickKind(members: Member[]): ExpectedRelationshipKind {
  const ops = new Set(members.map((m) => m.fact.operator));
  const windowEnds = new Set(members.map((m) => m.fact.windowEnd));
  const thresholds = new Set(members.map((m) => stringifyThreshold(m.fact)));

  // term_structure: same subject+operator+threshold, distinct windowEnd.
  if (ops.size === 1 && thresholds.size === 1 && windowEnds.size === members.length) {
    return "term_structure";
  }

  // partition: every member uses `in`.
  const allIn = members.every((m) => m.fact.operator === "in");
  if (allIn) return "mutually_exclusive";

  // nested / subset: directional comparators at distinct thresholds, same window.
  const directional = members.every((m) =>
    ["gte", "lte", "gt", "lt"].includes(m.fact.operator),
  );
  if (directional && thresholds.size === members.length && windowEnds.size === 1) {
    return "nested";
  }

  // Fallback — same family but no recognised relationship.
  return "co_moving";
}

function stringifyThreshold(fact: MarketFact): string {
  if (fact.thresholdSet) return `set:${[...fact.thresholdSet].sort().join("|")}`;
  if (fact.threshold === null) return "null";
  return `v:${String(fact.threshold)}`;
}

function buildCluster(
  subject: SubjectCode,
  members: Member[],
  kind: ExpectedRelationshipKind,
): DraftCluster {
  const sorted = [...members].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const marketIds = sorted.map((m) => m.market.marketId);
  const relationships = buildRelationships(subject, sorted, kind);
  const fact = sorted[0]!.fact;
  return {
    theme: `${subject} ${kind}`,
    causalDriver: subject,
    marketIds,
    expectedRelationships: relationships,
    rationale: `Deterministic cluster from MarketFacts (eventFamily=${canonicalEventFamily(fact)}).`,
    confidence: "high",
    derivedSubject: subject,
  };
}

function sortKey(m: Member): string {
  return `${m.fact.windowEnd}::${stringifyThreshold(m.fact)}::${m.market.marketId}`;
}

function buildRelationships(
  subject: SubjectCode,
  members: Member[],
  kind: ExpectedRelationshipKind,
): ExpectedRelationship[] {
  switch (kind) {
    case "nested": {
      // Sort ascending by threshold so each adjacent pair gives a subset
      // expectation: P(>= bigger) ≤ P(>= smaller).
      const numeric = members
        .map((m) => ({ m, n: numericThreshold(m.fact) }))
        .filter((x): x is { m: Member; n: number } => x.n !== null)
        .sort((a, b) => a.n - b.n);
      const out: ExpectedRelationship[] = [];
      for (let i = 0; i < numeric.length - 1; i += 1) {
        const lo = numeric[i]!;
        const hi = numeric[i + 1]!;
        out.push({
          kind: "nested",
          description: `P(${subject} ${opSymbol(hi.m.fact.operator)} ${formatThreshold(hi.m.fact)}) ≤ P(${subject} ${opSymbol(lo.m.fact.operator)} ${formatThreshold(lo.m.fact)})`,
        });
      }
      if (out.length === 0) {
        out.push({ kind: "nested", description: `${subject} narrower events cannot exceed wider events` });
      }
      return out;
    }
    case "mutually_exclusive": {
      const cats = members.map((m) => formatThreshold(m.fact)).join(", ");
      return [
        {
          kind: "mutually_exclusive",
          description: `Σ P(${subject} ∈ {${cats}}) ≤ 1`,
        },
      ];
    }
    case "term_structure": {
      const out: ExpectedRelationship[] = [];
      const sorted = [...members].sort((a, b) => a.fact.windowEnd - b.fact.windowEnd);
      for (let i = 0; i < sorted.length - 1; i += 1) {
        const earlier = sorted[i]!;
        const later = sorted[i + 1]!;
        out.push({
          kind: "term_structure",
          description: `P(${subject} ${opSymbol(earlier.fact.operator)} ${formatThreshold(earlier.fact)} by ${earlier.fact.windowEnd}) ≤ P(... by ${later.fact.windowEnd})`,
        });
      }
      return out;
    }
    case "co_moving":
    default:
      return [
        {
          kind: "co_moving",
          description: `${subject} markets in the same event family co-move`,
        },
      ];
  }
}

