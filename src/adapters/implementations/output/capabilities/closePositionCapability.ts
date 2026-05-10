import { InlineKeyboard } from "grammy";
import { PREDICTION_MARKETS_ENV } from "../../../../helpers/env/predictionMarketEnv";
import { MINI_APP_URL } from "../../../../helpers/env/telegramEnv";
import {
  formatPnlCents,
  formatPriceBps,
  formatUsdcCents,
} from "../../../../helpers/format/humanFormat";
import { createLogger } from "../../../../helpers/observability/logger";
import { newUuid } from "../../../../helpers/uuid";
import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type {
  IntentResult,
  ResultField,
} from "../../../../use-cases/interface/input/resultCard.types";
import type { IPredictionMarketBetUseCase } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketBetUseCase";

const log = createLogger("closePositionCapability");

// Skips the bet-intent table on purpose — the position row is the source of
// truth and the confirm card is built on demand from a live quote.

type ClosePositionParams =
  | { kind: "preview"; positionId: string }
  | { kind: "confirm"; positionId: string }
  | { kind: "cancel"; positionId: string };

const CALLBACK_PREFIXES = ["close_position", "confirm_close", "cancel_close"] as const;

export class ClosePositionCapability implements Capability<ClosePositionParams> {
  readonly id = "close_position";
  readonly triggers: TriggerSpec = {
    callbackPrefix: [...CALLBACK_PREFIXES],
  };

  constructor(private readonly betUseCase: IPredictionMarketBetUseCase) {}

  async collect(ctx: CapabilityCtx): Promise<CollectResult<ClosePositionParams>> {
    if (!PREDICTION_MARKETS_ENV.betsEnabled) {
      return terminal("Prediction-market betting is not enabled in this build.");
    }
    if (ctx.input.kind !== "callback") {
      return terminal("Tap a position card to close.");
    }
    const data = ctx.input.data;

    const close = data.match(/^close_position:([0-9a-f-]+)$/);
    if (close) return { kind: "ok", params: { kind: "preview", positionId: close[1]! } };

    const confirm = data.match(/^confirm_close:([0-9a-f-]+)$/);
    if (confirm) return { kind: "ok", params: { kind: "confirm", positionId: confirm[1]! } };

    const cancel = data.match(/^cancel_close:([0-9a-f-]+)$/);
    if (cancel) return { kind: "ok", params: { kind: "cancel", positionId: cancel[1]! } };

    return terminal("That close option has expired. Open the position card again.");
  }

  async run(params: ClosePositionParams, ctx: CapabilityCtx): Promise<Artifact> {
    if (params.kind === "preview") {
      const preview = await this.betUseCase.previewClose(ctx.userId, params.positionId);
      if (!preview) {
        return chat("That position is no longer open.");
      }
      return previewArtifact(params.positionId, preview);
    }

    if (params.kind === "confirm") {
      try {
        // Re-quote at confirm time so the recorded refPriceBps reflects the
        // price the user is actually betting on (drift between preview and
        // confirm taps can be material on thin books).
        const preview = await this.betUseCase.previewClose(ctx.userId, params.positionId);
        if (!preview) return chat("That position is no longer open.");
        await this.betUseCase.initiateClose({
          userId: ctx.userId,
          positionId: params.positionId,
          clientOrderId: newUuid(),
          refPriceBps: preview.bestBidPriceBps,
        });
        // Deep-link target is the *positionId*, not the new betId — the FE
        // ClosePositionHandler is keyed off positionId per
        // fe/.../utils/deepLink.ts (`close_position:<positionId>`).
        return openMiniAppArtifact(params.positionId);
      } catch (err) {
        log.error(
          { err, userId: ctx.userId, positionId: params.positionId },
          "close-confirm-failed",
        );
        return chat(`Couldn't start the close: ${humanizeError(err)}`);
      }
    }

    log.info({ userId: ctx.userId, positionId: params.positionId, step: "cancelled" }, "close-position");
    return chat("Close cancelled.");
  }
}

// ─── Artifact builders ───────────────────────────────────────────────────

function previewArtifact(
  positionId: string,
  preview: {
    position: { sizeShares: string; entryPriceAvgBps: number; entryStakeUsdcCents: number };
    bestBidPriceBps: number;
    estProceedsUsdcCents: number;
    estPnlUsdcCents: number;
  },
): Artifact {
  const { position, bestBidPriceBps, estProceedsUsdcCents, estPnlUsdcCents } = preview;
  const sizeQty = Number(position.sizeShares);
  const pctChange =
    position.entryStakeUsdcCents > 0
      ? (estPnlUsdcCents / position.entryStakeUsdcCents) * 100
      : 0;
  const pctSign = pctChange >= 0 ? "+" : "";
  const fields: ResultField[] = [
    { label: "Size", value: `${sizeQty.toFixed(2)} shares` },
    { label: "Quote (bid)", value: formatPriceBps(bestBidPriceBps) },
    { label: "Est. proceeds", value: formatUsdcCents(estProceedsUsdcCents), emphasis: "primary" },
    { label: "Entry stake", value: formatUsdcCents(position.entryStakeUsdcCents) },
    {
      label: "Est. PnL",
      value: `${formatPnlCents(estPnlUsdcCents)} (${pctSign}${pctChange.toFixed(1)}%)`,
      emphasis: "primary",
    },
  ];
  const result: IntentResult = {
    // `pending` (not `preview`) — the Telegram renderer drops preview cards
    // by design (mini-app surface only). Chat-side confirmation must render.
    status: "pending",
    verb: "prediction_market_position_open",
    headline: "Confirm close",
    fields,
    complexity: "complex",
    nextActions: [
      { label: "Confirm", kind: "callback", payload: `confirm_close:${positionId}` },
      { label: "Cancel", kind: "callback", payload: `cancel_close:${positionId}` },
    ],
  };
  const keyboard = new InlineKeyboard()
    .text("Confirm", `confirm_close:${positionId}`)
    .text("Cancel", `cancel_close:${positionId}`);
  return { kind: "result_card", result, keyboard };
}

function openMiniAppArtifact(positionId: string): Artifact {
  const text = `Close started. Open the mini app to finish (position \`${positionId.slice(0, 8)}…\`).`;
  if (!MINI_APP_URL) {
    return { kind: "chat", text, parseMode: "Markdown" };
  }
  const url = `${MINI_APP_URL}?startapp=close_position:${positionId}`;
  return {
    kind: "chat",
    text,
    parseMode: "Markdown",
    keyboard: new InlineKeyboard().webApp("Open mini app", url),
  };
}

function chat(text: string): Artifact {
  return { kind: "chat", text };
}

function terminal(text: string): CollectResult<ClosePositionParams> {
  return { kind: "terminal", artifact: { kind: "chat", text } };
}

function humanizeError(err: unknown): string {
  if (!(err instanceof Error)) return "Something went wrong.";
  const code = err.message.split(":")[0] ?? "";
  switch (code) {
    case "POSITION_NOT_FOUND":     return "That position no longer exists.";
    case "POSITION_WRONG_STATUS":  return "This position isn't open for closing right now.";
    case "BET_IN_FLIGHT":          return "You already have a bet being placed. Wait for it to settle, then try again.";
    default:
      return "Couldn't start the close. Please try again.";
  }
}
