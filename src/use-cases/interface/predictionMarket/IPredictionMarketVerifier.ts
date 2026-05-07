import type {
  DraftFinding,
  RawMarket,
  StoredCluster,
  VerifiedFinding,
} from "./PredictionMarketTypes";

export interface VerifierContext {
  reqId: string;
  runId: string;
  cluster: StoredCluster;
  /** Snapshot rows for this cluster's markets at the start of the tick. */
  snapshotMembers: RawMarket[];
  drafts: DraftFinding[];
}

export interface IPredictionMarketVerifier {
  /**
   * Pure deterministic gate. Re-pulls live odds, applies pattern-specific
   * checks, drops drafts that no longer hold, and assigns `magnitudeBps` +
   * `rankScore` for ordering.
   */
  verify(ctx: VerifierContext): Promise<VerifiedFinding[]>;
}
