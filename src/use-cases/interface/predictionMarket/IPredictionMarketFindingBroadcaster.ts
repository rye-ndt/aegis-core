import type { RawMarket, StoredCluster, VerifiedFinding } from "./PredictionMarketTypes";

export interface FindingBroadcastInput {
  runId: string;
  reqId: string;
  /** Already sorted by `rankScore DESC`. */
  findings: VerifiedFinding[];
  clusterById: Map<string, StoredCluster>;
  marketById: Map<string, RawMarket>;
}

export interface FindingBroadcastResult {
  /** Total per-user sends that succeeded across all findings. */
  sent: number;
  /** Per-user skips (dedupe hit, missing chatId, etc.). */
  skipped: number;
}

export interface IPredictionMarketFindingBroadcaster {
  broadcast(input: FindingBroadcastInput): Promise<FindingBroadcastResult>;
}
