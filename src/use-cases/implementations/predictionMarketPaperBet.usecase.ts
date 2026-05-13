import { createLogger } from "../../helpers/observability/logger";
import { PREDICTION_MARKETS_ENV } from "../../helpers/env/predictionMarketEnv";
import type { IPolymarketAdapter } from "../interface/predictionMarket/IPolymarketAdapter";
import type {
  IPredictionMarketRepository,
} from "../interface/predictionMarket/IPredictionMarketRepository";
import type { IPredictionMarketProvider } from "../interface/predictionMarket/IPredictionMarketProvider";
import type { IPredictionMarketPaperBetRepository } from "../interface/predictionMarket/IPredictionMarketPaperBetRepository";
import type {
  PaperBet,
  PaperBetSide,
} from "../interface/predictionMarket/PaperBetTypes";
import type {
  SideThesis,
  StoredFinding,
} from "../interface/predictionMarket/PredictionMarketTypes";

const log = createLogger("PaperBetUseCase");

export type FindingSideSelector = "A" | "B";
export type WireSide = "A" | "B" | "YES" | "NO";

export class PaperBetValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PaperBetValidationError";
  }
}

export class PaperBetNotFoundError extends Error {
  constructor(public readonly entity: "finding" | "cluster") {
    super(`not-found:${entity}`);
    this.name = "PaperBetNotFoundError";
  }
}

export class PaperBetPriceUnavailableError extends Error {
  constructor() {
    super("price-unavailable");
    this.name = "PaperBetPriceUnavailableError";
  }
}

export interface PlacePaperBetArgs {
  reqId: string;
  userId: string;
  findingId: string;
  /**
   * Wire-form side as accepted by the HTTP route. `'A'|'B'` map directly to
   * `sideA`/`sideB`; `'YES'|'NO'` resolve by matching `SideThesis.outcome`
   * — first match wins (rare ambiguity logged at debug).
   */
  side: WireSide;
  stakeUsdcCents: number;
}

const PRICE_TO_BPS = 10_000;

export class PredictionMarketPaperBetUseCase {
  constructor(
    private readonly paperBetRepo: IPredictionMarketPaperBetRepository,
    private readonly findingRepo: IPredictionMarketRepository,
    private readonly provider: IPredictionMarketProvider,
    private readonly polymarket: IPolymarketAdapter,
    private readonly cfg: {
      paperStakeMinUsdcCents: number;
      paperStakeMaxUsdcCents: number;
    } = {
      paperStakeMinUsdcCents: PREDICTION_MARKETS_ENV.paperStakeMinUsdcCents,
      paperStakeMaxUsdcCents: PREDICTION_MARKETS_ENV.paperStakeMaxUsdcCents,
    },
  ) {}

  async place(args: PlacePaperBetArgs): Promise<PaperBet> {
    const { reqId, userId, findingId, side, stakeUsdcCents } = args;
    log.info(
      { step: "started", reqId, userId, findingId, side, stakeUsdcCents },
      "paper-bet place",
    );

    if (!Number.isInteger(stakeUsdcCents) || stakeUsdcCents <= 0) {
      throw new PaperBetValidationError("stake-not-positive-int");
    }
    if (stakeUsdcCents < this.cfg.paperStakeMinUsdcCents) {
      throw new PaperBetValidationError("stake-below-min");
    }
    if (stakeUsdcCents > this.cfg.paperStakeMaxUsdcCents) {
      throw new PaperBetValidationError("stake-above-max");
    }

    const quote = await this.resolveQuote(reqId, findingId, side);
    const { cluster, marketId, betOutcome, priceBps } = quote;

    // sharesE6 = stakeUsdcCents × 100 × 1e6 / priceBps. BigInt preserves precision.
    const sharesE6 = (BigInt(stakeUsdcCents) * 100n * 1_000_000n) / BigInt(priceBps);

    // Frozen at insert: cluster rows are scan-versioned and may churn.
    const detectorSource = cluster.derivedSubject ? "deterministic" : "llm";
    const row = await this.paperBetRepo.insert({
      userId,
      findingId,
      clusterId: cluster.clusterId,
      marketId,
      subject: cluster.derivedSubject ?? null,
      side: betOutcome,
      stakeUsdcCents,
      entryPriceBps: priceBps,
      sharesE6,
      detectorSource,
    });

    log.info(
      {
        step: "succeeded",
        reqId,
        userId,
        findingId,
        paperBetId: row.id,
        marketId,
        side: betOutcome,
        priceBps,
        detectorSource,
      },
      "paper-bet placed",
    );
    return row;
  }

  /**
   * Read-only twin of {@link place} — resolves the same market+side+price the
   * placement would snapshot, returns it without writing a row. Lets the FE
   * show a live price and stake bounds before the user commits. Same error
   * classes as `place()` so callers get a consistent failure surface.
   */
  async preview(args: {
    reqId: string;
    findingId: string;
    side: WireSide;
  }): Promise<{
    findingId: string;
    marketId: string;
    side: PaperBetSide;
    sideLabel: string;
    rationale: string;
    whyAnomalous: string;
    priceBps: number;
    minStakeUsdcCents: number;
    maxStakeUsdcCents: number;
  }> {
    const { reqId, findingId, side } = args;
    log.debug({ reqId, findingId, side }, "paper-bet preview");
    const { finding, thesis, marketId, betOutcome, priceBps } =
      await this.resolveQuote(reqId, findingId, side);

    return {
      findingId,
      marketId,
      side: betOutcome,
      sideLabel: thesis.label,
      rationale: thesis.rationale,
      whyAnomalous: finding.whyAnomalous,
      priceBps,
      minStakeUsdcCents: this.cfg.paperStakeMinUsdcCents,
      maxStakeUsdcCents: this.cfg.paperStakeMaxUsdcCents,
    };
  }

  /**
   * Shared prelude for {@link place} and {@link preview}: load finding +
   * cluster, resolve the side to a SideThesis + outcome token id, snapshot
   * the CLOB best-ask and reject degenerate (0 / 1) books. Centralising it
   * here ensures the preview the FE shows is the exact same price the
   * placement would persist — they cannot drift.
   *
   * Buys YES/NO at best-ask: a 0/1 ask means the book is empty or pegged,
   * which we reject rather than commit to a 0bps or 10000bps fill.
   */
  private async resolveQuote(
    reqId: string,
    findingId: string,
    side: WireSide,
  ): Promise<{
    finding: StoredFinding;
    cluster: NonNullable<Awaited<ReturnType<IPredictionMarketRepository["getClusterById"]>>>;
    thesis: SideThesis;
    marketId: string;
    betOutcome: PaperBetSide;
    priceBps: number;
  }> {
    const finding = await this.findingRepo.getFinding(findingId);
    if (!finding) throw new PaperBetNotFoundError("finding");
    const cluster = await this.findingRepo.getClusterById(finding.clusterId);
    if (!cluster) throw new PaperBetNotFoundError("cluster");

    const selector = wireSideToSelector(finding, side, reqId);
    if (!selector) throw new PaperBetValidationError("side-has-no-matching-outcome");
    const thesis = pickSideThesis(finding, selector);
    if (!thesis?.marketId) throw new PaperBetValidationError("side-has-no-market");
    const { marketId } = thesis;
    const betOutcome: PaperBetSide = thesis.outcome;

    const tokenId = await this.resolveOutcomeTokenId(marketId, betOutcome, reqId);
    if (!tokenId) {
      log.warn({ reqId, marketId, betOutcome }, "paper-bet rejected: token id unresolved");
      throw new PaperBetPriceUnavailableError();
    }

    const tob = await this.polymarket.getOrderbookTopOfBook(tokenId);
    const priceBps = Math.round(tob.bestAskPrice * PRICE_TO_BPS);
    if (priceBps <= 0 || priceBps >= PRICE_TO_BPS) {
      log.warn(
        { reqId, marketId, tokenId, priceBps, bestBid: tob.bestBidPrice, bestAsk: tob.bestAskPrice },
        "paper-bet rejected: degenerate price",
      );
      throw new PaperBetPriceUnavailableError();
    }
    log.debug({ reqId, marketId, tokenId, betOutcome, priceBps }, "paper-bet price snapshot");
    return { finding, cluster, thesis, marketId, betOutcome, priceBps };
  }

  /**
   * Look up the user's prior bets — thin pass-through so the HTTP layer
   * doesn't reach into the repo directly.
   */
  async listForUser(
    userId: string,
    opts: { limit?: number; status?: PaperBet["status"] } = {},
  ): Promise<PaperBet[]> {
    return this.paperBetRepo.listByUser(userId, opts);
  }

  /** Pass-through aggregation. `userId` omitted → global (admin route). */
  async aggregatePerformance(args: {
    userId?: string;
    groupBy: "overall" | "subject" | "clusterId" | "detectorSource";
    status?: PaperBet["status"];
    since?: Date;
  }) {
    return this.paperBetRepo.aggregatePerformance(args);
  }

  private async resolveOutcomeTokenId(
    marketId: string,
    outcome: PaperBetSide,
    reqId: string,
  ): Promise<string | null> {
    const cached = this.provider.getOutcomeTokens(marketId);
    if (cached) return outcome === "YES" ? cached.yes : cached.no;

    log.debug({ reqId, marketId }, "paper-bet token-cache miss; refetching");
    try {
      await this.provider.fetchByIds([marketId], reqId);
    } catch (err) {
      log.warn({ err, reqId, marketId }, "paper-bet token refetch failed");
      return null;
    }
    const refreshed = this.provider.getOutcomeTokens(marketId);
    if (!refreshed) return null;
    return outcome === "YES" ? refreshed.yes : refreshed.no;
  }
}

/**
 * Picks the SideThesis a positional A/B selector refers to. Exported for
 * unit testing (the mapping is small and pure, but we want a regression
 * trip-wire if the convention ever changes).
 */
export function pickSideThesis(
  finding: Pick<StoredFinding, "sideA" | "sideB">,
  selector: FindingSideSelector,
): SideThesis | null {
  const t = selector === "A" ? finding.sideA : finding.sideB;
  return t ?? null;
}

/**
 * Normalises the HTTP body's `side` field (`'A'|'B'|'YES'|'NO'`) to a
 * positional selector. `'YES'`/`'NO'` resolve by matching `SideThesis.outcome`;
 * when both sides happen to share the same outcome (rare — both YES on
 * different markets), the first match wins and the call is logged at debug
 * so we can spot if direct API callers hit the ambiguity in practice.
 */
export function wireSideToSelector(
  finding: Pick<StoredFinding, "sideA" | "sideB">,
  bodySide: WireSide,
  reqId?: string,
): FindingSideSelector | null {
  if (bodySide === "A" || bodySide === "B") return bodySide;
  const aMatch = finding.sideA?.outcome === bodySide;
  const bMatch = finding.sideB?.outcome === bodySide;
  if (aMatch && bMatch) {
    log.debug({ reqId, bodySide }, "wire-side ambiguous: both sides match outcome, picking A");
  }
  if (aMatch) return "A";
  if (bMatch) return "B";
  return null;
}
