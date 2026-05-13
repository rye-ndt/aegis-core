/**
 * Paper-bet domain types for the prediction-market evaluation flow
 * (`constructions/2026-05-11-prediction-markets-paper-bets-part1.md`).
 *
 * Pure types only — no methods, no framework imports. The shares-from-stake
 * derivation helper lives in the use-case (Part 2), not here.
 *
 * `sharesE6` is shares × 1e6 stored as a BigInt so we never persist floats and
 * can sum exactly. Derivation:
 *   sharesE6 = (stakeUsdcCents * 1_000_000n * 100n) / BigInt(entryPriceBps)
 * Equivalent to (stake / price) shares with two extra decimal points of
 * precision than cents alone.
 */

export type PaperBetSide = "YES" | "NO";
export type PaperBetStatus = "open" | "resolved" | "voided";
export type DetectorSource = "deterministic" | "llm";

export interface PaperBet {
  id: string;
  userId: string;
  findingId: string;
  clusterId: string;
  marketId: string;
  /** Denormalized from the cluster row at insert time; null for LLM-clustered findings. */
  subject: string | null;
  side: PaperBetSide;
  stakeUsdcCents: number;
  /** CLOB top-of-book at confirm. 0..10_000. */
  entryPriceBps: number;
  /**
   * shares × 1e6, stored as BigInt. Resolution payout (Part 3):
   * `payout_cents = sharesE6 / 10_000` (Polymarket pays $1 per winning
   * share = 100 cents). Stake/share derivation lives in the placement
   * use-case (Part 2).
   */
  sharesE6: bigint;
  /** Provenance — populated from the source cluster's `derivedSubject` presence. */
  detectorSource: DetectorSource;
  status: PaperBetStatus;
  outcome: PaperBetSide | null;
  payoutUsdcCents: number | null;
  realizedPnlUsdcCents: number | null;
  entryAt: Date;
  resolvedAt: Date | null;
}

export interface PaperBetInsert {
  userId: string;
  findingId: string;
  clusterId: string;
  marketId: string;
  subject: string | null;
  side: PaperBetSide;
  stakeUsdcCents: number;
  entryPriceBps: number;
  sharesE6: bigint;
  detectorSource: DetectorSource;
}

export interface PaperBetResolutionPatch {
  id: string;
  outcome: PaperBetSide;
  payoutUsdcCents: number;
  realizedPnlUsdcCents: number;
}
