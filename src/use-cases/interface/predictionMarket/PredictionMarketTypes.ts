/**
 * Shared shapes for the daily prediction-market feature (stages 1 & 2).
 * Provider, classifier, repository, broadcaster, and use case all import
 * from here so the domain types stay decoupled from any specific adapter.
 */

export interface RawMarket {
  /** Polymarket condition_id (canonical id we key everything on). */
  marketId: string;
  slug: string;
  question: string;
  /** Full resolution-criteria text — load-bearing input for the classifier. */
  resolutionCriteria: string;
  /** Polymarket-supplied tag, untrusted; passed to the LLM as `categoryHint`. */
  category: string | null;
  resolutionEpochSec: number;
  /** 0..1. */
  yesPrice: number;
  /** 0..1. */
  noPrice: number;
  openInterestUsd: number;
  volume7dUsd: number;
  liquidityUsd: number;
  isActive: boolean;
  isDisputed: boolean;
  /** Always 2 after the binary filter. */
  outcomesCount: number;
  url: string;
  /**
   * Transient — populated when available from the provider for stage 3
   * movement-divergence detection. Not persisted to `prediction_market_snapshots`.
   * Sign convention: positive = YES price went up.
   */
  priceChange24hBps?: number;
  priceChange7dBps?: number;
  /**
   * Polymarket Gamma `events[0].id`. Co-clustered markets share an event id;
   * the extractor (Phase 2) uses it as a fast-path collision check before
   * computing `canonicalEventFamily`. Optional — older snapshot rows have
   * null until refilled by the next scan.
   */
  polymarketEventId?: string | null;
}

export type ClusterConfidence = "low" | "medium" | "high";

export type ExpectedRelationshipKind =
  | "mutually_exclusive"
  | "nested"
  | "term_structure"
  | "co_moving"
  | "other";

export interface ExpectedRelationship {
  kind: ExpectedRelationshipKind;
  description: string;
}

export interface DraftCluster {
  theme: string;
  causalDriver: string;
  /** ≥3 marketIds; each id appears in at most one cluster across the run. */
  marketIds: string[];
  expectedRelationships: ExpectedRelationship[];
  rationale: string;
  confidence: ClusterConfidence;
  /** Populated by the deterministic clusterer (Part 4) when every member's
   *  `MarketFact.subject` agrees. Null for LLM-clustered rows. Part 5 uses
   *  this as the routing key between the deterministic and LLM detectors. */
  derivedSubject?: string | null;
}

export interface StoredCluster extends DraftCluster {
  clusterId: string;
  runId: string;
}

export type RunStatus = "fetched" | "clustered" | "published" | "failed";

export interface RunRow {
  runId: string;
  createdAtEpoch: number;
  universeHash: string;
  clusterSetHash: string | null;
  status: RunStatus;
  isLatest: boolean;
}

export interface RunOutcome {
  runId: string;
  fetched: number;
  clusters: number;
  published: number;
  broadcast: boolean;
  findingsDetected: number;
  findingsVerified: number;
  findingsBroadcast: number;
}

// ---- Stage 3: findings ----

export type FindingPatternType =
  | "logical_inconsistency"
  | "term_structure_anomaly"
  | "implied_contradiction"
  | "movement_divergence"
  | "other";

export type FindingConfidence = "low" | "medium" | "high";

export interface SideThesis {
  /** ≤60 chars, plain English. */
  label: string;
  /** Cluster member this side trades. */
  marketId: string;
  outcome: "YES" | "NO";
  /** ≤200 chars. */
  rationale: string;
}

export interface FindingCurrentState {
  /** marketId -> YES price 0..1 as cited by the LLM. */
  citedOdds: Record<string, number>;
}

export interface DraftFinding {
  patternType: FindingPatternType;
  /** Subset of cluster.marketIds, ≥2. */
  marketsInvolved: string[];
  currentState: FindingCurrentState;
  whyAnomalous: string;
  sideA: SideThesis;
  sideB: SideThesis;
  confidence: FindingConfidence;
  /** Written before the sides per prompt order. */
  rationale: string;
  /** Pattern-relative role tags. Optional for back-compat with carry-forward
   *  / cached drafts written before Phase 0; the detector prompt + schema
   *  require them at runtime for the structural patterns. */
  widerMarketId?: string;
  narrowerMarketId?: string;
  earlierMarketId?: string;
  laterMarketId?: string;
}

export interface VerifiedFinding extends DraftFinding {
  findingId: string;
  runId: string;
  clusterId: string;
  verifiedAtEpoch: number;
  /** Authoritative re-pulled YES prices, marketId -> 0..1. */
  liveOdds: Record<string, number>;
  /** Pattern-specific gap size in bps. */
  magnitudeBps: number;
  /** Ranking score multiplied by 1000 to fit `integer`. */
  rankScore: number;
  /** Phase 5 (Part 6) — optional LP-sizing outputs. Populated only when the
   *  sizer is enabled and the finding survives the uneconomic filter. */
  sizedTrades?: Array<{ marketId: string; outcome: "YES" | "NO"; shares: number; avgPriceFraction: number }>;
  expectedProfitUsdc?: number;
  /** Worst-case payoff across resolution branches; the broadcast card surfaces
   *  this as "worst case: $Y.YY". */
  minPayoffUsdc?: number;
}

export interface StoredFinding extends VerifiedFinding {
  createdAtEpoch: number;
  broadcastedAtEpoch: number | null;
}
