import type {
  DraftCluster,
  RawMarket,
  RunRow,
  RunStatus,
  StoredCluster,
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
  insertClusters(runId: string, clusters: DraftCluster[]): Promise<void>;
  updateRunStatus(
    runId: string,
    status: RunStatus,
    clusterSetHash?: string,
  ): Promise<void>;
  getMarketsByRun(runId: string): Promise<RawMarket[]>;
  getClustersByRun(runId: string): Promise<StoredCluster[]>;
}
