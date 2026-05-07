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

export interface IPredictionMarketDetector {
  /**
   * Returns zero or more draft findings. Empty result is the common case;
   * the LLM is explicitly told `{ findings: [] }` is acceptable.
   */
  detect(input: DetectorInput): Promise<DraftFinding[]>;
}
