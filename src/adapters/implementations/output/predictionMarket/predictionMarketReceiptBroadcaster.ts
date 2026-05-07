import type { Api } from "grammy";
import {
  formatPnlCents,
  formatPriceBps,
  formatUsdcCents,
} from "../../../../helpers/format/humanFormat";
import { PREDICTION_MARKETS_ENV } from "../../../../helpers/env/predictionMarketEnv";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  BetRow,
  PositionRow,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketBetRepository";
import type { IPredictionMarketReceiptBroadcaster } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketReceiptBroadcaster";
import type {
  IntentResult,
  ResultAction,
  ResultField,
} from "../../../../use-cases/interface/input/resultCard.types";
import { renderResultCard } from "../artifactRenderer/resultCard.render";

const log = createLogger("predictionMarketReceiptBroadcaster");

export interface PredictionMarketReceiptBroadcasterDeps {
  tgApi: Api;
  getChatId: (userId: string) => Promise<string | null>;
  /** Optional `?affiliate=…` query string for Polymarket links. */
  affiliateParam: string;
}

function polymarketMarketUrl(marketId: string, affiliate: string): string {
  // Polymarket's /market/ path accepts both slug and condition id; slug isn't
  // always known at receipt time, so we fall through to the id.
  const base = `https://polymarket.com/market/${encodeURIComponent(marketId)}`;
  if (!affiliate) return base;
  return `${base}?affiliate=${encodeURIComponent(affiliate)}`;
}

export class PredictionMarketReceiptBroadcaster
  implements IPredictionMarketReceiptBroadcaster
{
  constructor(private readonly deps: PredictionMarketReceiptBroadcasterDeps) {}

  async broadcastFinalizeOutcome(input: {
    userId: string;
    outcome: "FILLED" | "PARTIAL" | "UNFILLED" | "FAILED";
    bet: BetRow;
    position: PositionRow | null;
    closedPosition: PositionRow | null;
  }): Promise<void> {
    const { userId, outcome, bet, position, closedPosition } = input;
    if (outcome === "FAILED") {
      return this.broadcastBetFailed(userId, bet);
    }
    if (bet.betKind === "close" && closedPosition) {
      return this.broadcastPositionClosed(userId, closedPosition);
    }
    if (bet.betKind === "open") {
      return this.broadcastBetPlaced(userId, bet, position);
    }
    log.debug({ userId, outcome, betKind: bet.betKind }, "no-receipt-mapped");
  }

  async broadcastPositionResolved(input: { userId: string; position: PositionRow }): Promise<void> {
    const { userId, position } = input;
    const fields: ResultField[] = [
      { label: "Outcome", value: position.resolvedOutcome ?? "—", emphasis: "primary" },
      { label: "Side held", value: position.side },
      { label: "Payout", value: formatUsdcCents(position.realizedPnlUsdcCents), emphasis: "primary" },
    ];
    await this.push(userId, {
      status: "success",
      verb: "prediction_market_position_resolved",
      headline: "Market resolved",
      fields,
      complexity: "complex",
      nextActions: [this.openInPolymarket(position.marketId)],
    });
  }

  // ── Internal builders ────────────────────────────────────────────────────

  private async broadcastBetPlaced(
    userId: string,
    bet: BetRow,
    position: PositionRow | null,
  ): Promise<void> {
    const fields: ResultField[] = [
      { label: "Side", value: bet.side, emphasis: "primary" },
      { label: "Stake", value: formatUsdcCents(bet.stakeUsdcCents), emphasis: "primary" },
      { label: "Reference price", value: formatPriceBps(bet.refPriceBps) },
      { label: "Fill price", value: formatPriceBps(bet.filledAvgPriceBps) },
    ];
    if (bet.filledShares) {
      fields.push({ label: "Shares", value: Number(bet.filledShares).toFixed(2) });
      fields.push({ label: "Max payout if win", value: `$${Number(bet.filledShares).toFixed(2)}` });
    }
    const nextActions: ResultAction[] = [];
    if (position) {
      nextActions.push({
        label: "View position",
        kind: "callback",
        payload: `view_position:${position.id}`,
      });
    }
    nextActions.push(this.openInPolymarket(bet.marketId));

    await this.push(userId, {
      status: "success",
      verb: "prediction_market_bet_placed",
      headline: bet.status === "PARTIAL" ? "Bet partially filled" : "Bet placed",
      fields,
      complexity: "complex",
      nextActions,
      ...(bet.scaToEoaTxHash
        ? {
            txHashes: [
              { hash: bet.scaToEoaTxHash, chainId: PREDICTION_MARKETS_ENV.betChainId },
            ],
          }
        : {}),
    });
  }

  private async broadcastBetFailed(userId: string, bet: BetRow): Promise<void> {
    const fields: ResultField[] = [
      { label: "Side", value: bet.side },
      { label: "Stake", value: formatUsdcCents(bet.stakeUsdcCents) },
      { label: "Reason", value: bet.failureReason ?? "Unknown failure" },
      { label: "Last state", value: bet.status },
    ];
    const nextActions: ResultAction[] = bet.intentId
      ? [{ label: "Retry", kind: "callback", payload: `retry_bet:${bet.intentId}` }]
      : [];
    await this.push(userId, {
      status: "failed",
      verb: "prediction_market_bet_failed",
      headline: "Bet failed",
      fields,
      complexity: "simple",
      nextActions,
    });
  }

  private async broadcastPositionClosed(userId: string, position: PositionRow): Promise<void> {
    const fields: ResultField[] = [
      { label: "Entry price", value: formatPriceBps(position.entryPriceAvgBps) },
      { label: "Size", value: Number(position.sizeShares).toFixed(2) },
      { label: "Realized PnL", value: formatPnlCents(position.realizedPnlUsdcCents), emphasis: "primary" },
    ];
    await this.push(userId, {
      status: "success",
      verb: "prediction_market_position_closed",
      headline: "Position closed",
      fields,
      complexity: "complex",
      nextActions: [this.openInPolymarket(position.marketId)],
    });
  }

  private openInPolymarket(marketId: string): ResultAction {
    return {
      label: "Open in Polymarket",
      kind: "url",
      payload: polymarketMarketUrl(marketId, this.deps.affiliateParam),
    };
  }

  private async push(userId: string, result: IntentResult): Promise<void> {
    let chatIdRaw: string | null;
    try {
      chatIdRaw = await this.deps.getChatId(userId);
    } catch (err) {
      log.error({ err, userId, verb: result.verb }, "receipt-getChatId-failed");
      return;
    }
    if (!chatIdRaw) {
      log.debug({ userId, verb: result.verb }, "receipt-no-chat");
      return;
    }
    const chatId = Number(chatIdRaw);
    const rendered = renderResultCard({ result });
    try {
      await this.deps.tgApi.sendMessage(chatId, rendered.text, {
        parse_mode: rendered.parseMode,
        ...(rendered.keyboard ? { reply_markup: rendered.keyboard } : {}),
      });
      log.info({ userId, verb: result.verb, status: result.status }, "receipt-sent");
    } catch (err) {
      log.warn({ err, userId, verb: result.verb, mode: "markdownV2-retry-plain" }, "receipt-send-retry");
      const plain =
        `${result.headline}\n` +
        result.fields.map((f) => `${f.label}: ${f.value}`).join("\n");
      try {
        await this.deps.tgApi.sendMessage(chatId, plain, {
          ...(rendered.keyboard ? { reply_markup: rendered.keyboard } : {}),
        });
      } catch (err2) {
        log.error({ err: err2, userId, verb: result.verb }, "receipt-send-failed");
      }
    }
  }
}
