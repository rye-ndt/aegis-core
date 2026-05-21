import type {
  DraftFinding,
  RawMarket,
  StoredCluster,
} from "./PredictionMarketTypes";

export interface DetectorInput {
  cluster: StoredCluster;
  /** Current snapshot rows for this cluster's markets only. */
  members: RawMarket[];
  reqId: string;
}

export interface DetectorResult {
  /**
   * Zero or more draft findings. Empty result is the common case; the LLM
   * is explicitly told `{ findings: [] }` is acceptable.
   */
  drafts: DraftFinding[];
  /**
   * True iff this invocation was served from the Redis response cache (LLM
   * detector). Always false for the deterministic detector. Exposed so the
   * scan use case can roll up per-tick hit/miss counts at
   * `step: "stage3-end"`.
   */
  cacheHit: boolean;
}

export interface IPredictionMarketDetector {
  detect(input: DetectorInput): Promise<DetectorResult>;
}
