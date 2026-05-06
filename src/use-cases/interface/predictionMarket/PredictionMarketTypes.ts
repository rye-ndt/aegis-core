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
}
