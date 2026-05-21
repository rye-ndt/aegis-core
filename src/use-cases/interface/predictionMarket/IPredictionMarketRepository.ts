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
  /**
   * Resolve a set of `marketId`s to their latest known snapshot row, regardless
   * of whether the markets are still in the most recent run. Used by FE-facing
   * endpoints that render market metadata (e.g. `marketQuestion`) for stored
   * objects like positions, which may outlive a market's appearance in the
   * universe. Dedups the input, picks the row from the newest run per
   * `marketId`. Empty input returns `[]` without touching the DB. Markets
   * fully absent from the snapshots table are simply omitted from the result.
   */
  getMarketsByIds(ids: string[]): Promise<RawMarket[]>;
  getClustersByRun(runId: string): Promise<StoredCluster[]>;
  /**
   * Single-cluster lookup. Added for the paper-bet placement use-case
   * (Part 2) which needs `derivedSubject` to set `detectorSource` at insert
   * time without paging the whole run's clusters.
   */
  getClusterById(clusterId: string): Promise<StoredCluster | null>;
  insertFindings(findings: VerifiedFinding[]): Promise<void>;
  markFindingsBroadcasted(findingIds: string[], epoch: number): Promise<void>;
  getFindingsByRun(runId: string): Promise<StoredFinding[]>;
  getFinding(findingId: string): Promise<StoredFinding | null>;
  /** Phase 3 shadow output — never broadcast, only used by the diff script. */
  insertShadowClusters(
    runId: string,
    clusters: DraftCluster[],
    createdAtEpoch: number,
  ): Promise<void>;
  /** Phase 4 shadow output — deterministic detector results never broadcast. */
  insertShadowFindings(input: InsertShadowFindingInput[]): Promise<void>;
  /** Returns per-subject agreement stats over the trailing `windowSec`. Used
   *  by `GET /admin/prediction-markets/shadow-agreement`. */
  getShadowAgreement(windowSec: number): Promise<ShadowAgreementReport>;
}

export type ShadowFindingSource =
  | { kind: "real"; realClusterId: string }
  | { kind: "shadow"; shadowClusterId: string };

export interface InsertShadowFindingInput {
  runId: string;
  source: ShadowFindingSource;
  patternType: string;
  marketsInvolved: string[];
  liveOdds: Record<string, number>;
  magnitudeBps: number;
  widerMarketId: string | null;
  narrowerMarketId: string | null;
  earlierMarketId: string | null;
  laterMarketId: string | null;
  rationale: string;
  confidence: string;
  createdAtEpoch: number;
}

export interface ShadowAgreementSubjectRow {
  subject: string;
  llmOnly: number;
  shadowOnly: number;
  agreed: number;
  agreementPct: number;
}

export interface ShadowAgreementReport {
  perSubject: ShadowAgreementSubjectRow[];
  overall: { llmOnly: number; shadowOnly: number; agreed: number; agreementPct: number };
  windowDays: number;
}
