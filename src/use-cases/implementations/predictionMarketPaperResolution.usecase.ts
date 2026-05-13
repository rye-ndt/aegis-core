import { createLogger } from "../../helpers/observability/logger";
import type { IPredictionMarketPaperBetRepository } from "../interface/predictionMarket/IPredictionMarketPaperBetRepository";
import type { IPolymarketResolutionFetcher } from "../interface/predictionMarket/IPolymarketResolutionFetcher";
import type { PaperBetResolutionPatch } from "../interface/predictionMarket/PaperBetTypes";

const log = createLogger("PaperResolutionUseCase");

export interface PaperResolutionTickResult {
  checked: number;
  resolved: number;
}

export class PredictionMarketPaperResolutionUseCase {
  constructor(
    private readonly paperBetRepo: IPredictionMarketPaperBetRepository,
    private readonly resolutionFetcher: IPolymarketResolutionFetcher,
    private readonly cfg: { batchSize: number },
  ) {}

  async tick(reqId: string): Promise<PaperResolutionTickResult> {
    const start = Date.now();
    log.info({ step: "tick-start", reqId }, "paper-resolution tick");

    const marketIds = await this.paperBetRepo.listOpenMarketIds();
    if (marketIds.length === 0) {
      log.info(
        { step: "tick-end", reqId, durationMs: Date.now() - start, checked: 0, resolved: 0 },
        "no open bets",
      );
      return { checked: 0, resolved: 0 };
    }

    const batch = marketIds.slice(0, Math.max(1, this.cfg.batchSize));
    const resolved = await this.resolutionFetcher.fetchMany(batch);
    if (resolved.length === 0) {
      log.info(
        {
          step: "tick-end",
          reqId,
          durationMs: Date.now() - start,
          checked: batch.length,
          resolved: 0,
        },
        "no resolutions this tick",
      );
      return { checked: batch.length, resolved: 0 };
    }

    const resolvedMarketIds = resolved.map((r) => r.marketId);
    const openBets = await this.paperBetRepo.listOpenByMarkets(resolvedMarketIds);
    const byMarket = new Map(resolved.map((r) => [r.marketId, r]));

    const patches: PaperBetResolutionPatch[] = [];
    for (const bet of openBets) {
      const res = byMarket.get(bet.marketId);
      if (!res) continue;
      const won = bet.side === res.outcome;
      // Polymarket settles $1 (100¢) per winning share; sharesE6 is shares×1e6,
      // so payoutCents = sharesE6 × 100 / 1e6 = sharesE6 / 10_000.
      const payoutCentsBig = won ? bet.sharesE6 / 10_000n : 0n;
      const payoutUsdcCents = Number(payoutCentsBig);
      const realizedPnlUsdcCents = payoutUsdcCents - bet.stakeUsdcCents;
      patches.push({
        id: bet.id,
        outcome: res.outcome,
        payoutUsdcCents,
        realizedPnlUsdcCents,
      });
    }

    const resolvedCount = await this.paperBetRepo.resolveMany(patches);
    log.info(
      {
        step: "tick-end",
        reqId,
        durationMs: Date.now() - start,
        checked: batch.length,
        resolved: resolvedCount,
        markets: resolved.length,
      },
      "paper-resolution tick complete",
    );
    return { checked: batch.length, resolved: resolvedCount };
  }
}
