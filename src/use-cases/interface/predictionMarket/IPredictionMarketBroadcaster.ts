import type { DraftCluster } from "./PredictionMarketTypes";

export interface IPredictionMarketBroadcaster {
  /**
   * Fan-out the published clusters to every active telegram user, gated by
   * a per-user redis dedupe key keyed on `clusterSetHash`. Returns the count
   * of users actually messaged (post-dedupe).
   */
  broadcast(args: {
    runId: string;
    clusterSetHash: string;
    clusters: DraftCluster[];
    reqId: string;
  }): Promise<{ sent: number; skipped: number }>;
}
