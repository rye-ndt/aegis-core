import type {
  DraftCluster,
  RawMarket,
  RunRow,
  RunStatus,
  StoredCluster,
  StoredFinding,
  VerifiedFinding,
} from "./PredictionMarketTypes";

export interface InsertRunInput {
  runId: string;
  createdAtEpoch: number;
  universeHash: string;
  clusterSetHash: string | null;
  status: RunStatus;
}

export interface IPredictionMarketRepository {
  insertRun(run: InsertRunInput): Promise<void>;
  /** Atomically clears `is_latest` on the previous winner and sets it on `runId`. */
  setLatestRun(runId: string): Promise<void>;
  getLatestRun(): Promise<RunRow | null>;
  insertMarkets(runId: string, markets: RawMarket[]): Promise<void>;
  /**
   * Persists clusters for a run. Each input may carry a pre-assigned
   * `clusterId` — the carry-forward path uses this to keep ids stable across
   * runs so stage-3 detector cache and `prediction_market_findings.cluster_id`
   * correlate. When `clusterId` is absent a fresh UUID is minted.
   */
  insertClusters(
    runId: string,
    clusters: Array<DraftCluster & { clusterId?: string }>,
  ): Promise<StoredCluster[]>;
  updateRunStatus(
    runId: string,
    status: RunStatus,
    clusterSetHash?: string,
  ): Promise<void>;
  getMarketsByRun(runId: string): Promise<RawMarket[]>;
  getClustersByRun(runId: string): Promise<StoredCluster[]>;
  insertFindings(findings: VerifiedFinding[]): Promise<void>;
  markFindingsBroadcasted(findingIds: string[], epoch: number): Promise<void>;
  getFindingsByRun(runId: string): Promise<StoredFinding[]>;
}
