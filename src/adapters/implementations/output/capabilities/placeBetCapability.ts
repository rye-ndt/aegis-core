import { InlineKeyboard } from "grammy";
import { PREDICTION_MARKETS_ENV } from "../../../../helpers/env/predictionMarketEnv";
import { createLogger } from "../../../../helpers/observability/logger";
import { newUuid } from "../../../../helpers/uuid";
import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type { IntentResult, ResultField } from "../../../../use-cases/interface/input/resultCard.types";
import type { IPredictionMarketBetUseCase } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketBetUseCase";

const log = createLogger("placeBetCapability");

/**
 * Chat-side state machine for placing a prediction-market bet. Owns only the
 * chat surface; the mini-app drives the on-chain flow via `/predictionMarket/*`.
 */

type PlaceBetState =
  | { stage: "awaiting_amount"; intentId: string }
  | { stage: "awaiting_confirm"; intentId: string };

type PlaceBetParams =
  | { kind: "amount"; intentId: string; stakeUsdc: number }
  | { kind: "confirm"; intentId: string }
  | { kind: "cancel"; intentId: string };

const CALLBACK_PREFIXES = ["place_bet", "confirm_bet", "cancel_bet"] as const;

/** Callback layout: `place_bet:<findingId>:<marketId>:<side>` */
const PLACE_BET_RX = /^place_bet:([^:]+):([^:]+):(A|B)$/;

export class PlaceBetCapability implements Capability<PlaceBetParams> {
  readonly id = "place_bet";
  readonly triggers: TriggerSpec = {
    callbackPrefix: [...CALLBACK_PREFIXES],
  };

  constructor(private readonly betUseCase: IPredictionMarketBetUseCase) {}

  async collect(
    ctx: CapabilityCtx,
    resuming?: Record<string, unknown>,
  ): Promise<CollectResult<PlaceBetParams>> {
    const state = resuming as PlaceBetState | undefined;

    if (!PREDICTION_MARKETS_ENV.betsEnabled) {
      return terminalChat("Prediction-market betting is not enabled in this build.");
    }

    // ── Callback path ────────────────────────────────────────────────────
    if (ctx.input.kind === "callback") {
      const data = ctx.input.data;

      const placeMatch = data.match(PLACE_BET_RX);
      if (placeMatch) {
        const [, findingId, marketId, side] = placeMatch;
        const result = await this.betUseCase.initiateBetIntent({
          userId: ctx.userId,
          findingId: findingId === "_" ? null : findingId!,
          marketId: marketId!,
          side: side!,
          outcomeTokenId: null,
          refPriceBps: null,
        });
        return {
          kind: "ask",
          question:
            `How much USDC do you want to bet on **Side ${side}**?\n` +
            `Reply with an amount (min $${result.minStakeUsdc}, max $${result.maxStakeUsdc}).`,
          parseMode: "Markdown",
          state: { stage: "awaiting_amount", intentId: result.intent.id },
        };
      }

      const confirmMatch = data.match(/^confirm_bet:([0-9a-f-]+)$/);
      if (confirmMatch) {
        return { kind: "ok", params: { kind: "confirm", intentId: confirmMatch[1]! } };
      }

      const cancelMatch = data.match(/^cancel_bet:([0-9a-f-]+)$/);
      if (cancelMatch) {
        return { kind: "ok", params: { kind: "cancel", intentId: cancelMatch[1]! } };
      }

      return terminalChat("That bet option has expired. Tap a side on the finding again to start over.");
    }

    // ── Text path (amount reply during `awaiting_amount`) ─────────────────
    if (state?.stage === "awaiting_amount") {
      const amount = parseStakeAmount(ctx.input.text);
      if (amount === null) {
        return {
          kind: "ask",
          question: `Please reply with a USDC amount, e.g. \`10\` (min $${PREDICTION_MARKETS_ENV.minStakeUsdc}, max $${PREDICTION_MARKETS_ENV.maxStakeUsdc}).`,
          parseMode: "Markdown",
          state,
        };
      }
      return { kind: "ok", params: { kind: "amount", intentId: state.intentId, stakeUsdc: amount } };
    }

    // No matching state — let the dispatcher fall through.
    return terminalChat("No active bet in progress. Tap a side on a finding card to start.");
  }

  async run(params: PlaceBetParams, ctx: CapabilityCtx): Promise<Artifact> {
    if (params.kind === "amount") {
      const r = await this.betUseCase.submitAmount({
        userId: ctx.userId,
        intentId: params.intentId,
        stakeUsdc: params.stakeUsdc,
      });
      if (r.kind === "rejected") {
        return rejectionArtifact(r.reason);
      }
      return confirmCardArtifact(r.intent, params.stakeUsdc);
    }

    if (params.kind === "confirm") {
      try {
        const bet = await this.betUseCase.confirmBetIntent({
          userId: ctx.userId,
          intentId: params.intentId,
          clientOrderId: newUuid(),
        });
        return openMiniAppArtifact(bet.id);
      } catch (err) {
        log.error({ err, userId: ctx.userId, intentId: params.intentId }, "confirm-failed");
        return resultArtifact({
          status: "failed",
          verb: "prediction_market_bet_failed",
          headline: "Couldn't start the bet",
          fields: [
            { label: "Reason", value: humanizeError(err) },
          ],
          complexity: "simple",
        });
      }
    }

    // params.kind === "cancel"
    await this.betUseCase.cancelBetIntent(ctx.userId, params.intentId);
    return resultArtifact({
      status: "success",
      verb: "prediction_market_bet_failed",
      headline: "Bet cancelled",
      fields: [{ label: "Status", value: "Intent dropped." }],
      complexity: "simple",
    });
  }
}

// ─── Artifact builders ───────────────────────────────────────────────────

function rejectionArtifact(
  reason: "below-min" | "above-max" | "not-found" | "wrong-status",
): Artifact {
  const text = (() => {
    switch (reason) {
      case "below-min": return `Stake is below the minimum ($${PREDICTION_MARKETS_ENV.minStakeUsdc}).`;
      case "above-max": return `Stake is above the maximum ($${PREDICTION_MARKETS_ENV.maxStakeUsdc}).`;
      case "not-found": return "That bet intent has expired.";
      case "wrong-status": return "This bet is no longer awaiting an amount.";
    }
  })();
  return { kind: "chat", text };
}

function confirmCardArtifact(
  intent: { id: string; side: string; refPriceBps: number | null; outcomeTokenId: string | null },
  stakeUsdc: number,
): Artifact {
  const ref = intent.refPriceBps ? intent.refPriceBps / 10_000 : null;
  const shares = ref && ref > 0 ? stakeUsdc / ref : null;
  const fields: ResultField[] = [
    { label: "Side", value: intent.side, emphasis: "primary" },
    { label: "Stake", value: `$${stakeUsdc.toFixed(2)} USDC`, emphasis: "primary" },
    { label: "Bridge", value: "Avalanche → Polygon (~30s, ~$0.02 fee)" },
  ];
  if (ref !== null) fields.push({ label: "Reference price", value: `$${ref.toFixed(2)}` });
  if (shares !== null) {
    fields.push({ label: "Est. shares", value: `${shares.toFixed(2)}` });
    fields.push({ label: "Max payout if win", value: `$${shares.toFixed(2)}` });
  }
  const result: IntentResult = {
    status: "preview",
    verb: "prediction_market_bet_confirm",
    headline: "Confirm bet",
    fields,
    complexity: "complex",
    nextActions: [
      { label: "Confirm", kind: "callback", payload: `confirm_bet:${intent.id}` },
      { label: "Cancel", kind: "callback", payload: `cancel_bet:${intent.id}` },
    ],
  };
  const keyboard = new InlineKeyboard()
    .text("Confirm", `confirm_bet:${intent.id}`)
    .text("Cancel", `cancel_bet:${intent.id}`);
  return { kind: "result_card", result, keyboard };
}

function openMiniAppArtifact(betId: string): Artifact {
  return {
    kind: "chat",
    text: `Bet started. Open the mini app to finish placing it (intent id \`${betId.slice(0, 8)}…\`).`,
    parseMode: "Markdown",
    keyboard: new InlineKeyboard().text("Open mini app", `open_app:bet:${betId}`),
  };
}

function resultArtifact(result: IntentResult): Artifact {
  return { kind: "result_card", result };
}

function terminalChat(text: string): CollectResult<PlaceBetParams> {
  return { kind: "terminal", artifact: { kind: "chat", text } };
}

function parseStakeAmount(text: string): number | null {
  const m = text.trim().match(/^\$?\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Map internal error codes (thrown as `Error` with code-like messages) to
 * chat-safe text. Anything we don't recognize falls through to a generic
 * label — internal codes like `INTENT_WRONG_STATUS:awaiting_amount` should
 * never reach the user surface.
 */
function humanizeError(err: unknown): string {
  if (!(err instanceof Error)) return "Something went wrong.";
  const code = err.message.split(":")[0] ?? "";
  switch (code) {
    case "INTENT_NOT_FOUND":      return "That bet has expired. Tap a side on the finding card to start again.";
    case "INTENT_WRONG_STATUS":   return "This bet is no longer awaiting confirmation.";
    case "INTENT_INCOMPLETE":     return "Please reply with an amount before confirming.";
    case "BET_IN_FLIGHT":         return "You already have a bet being placed. Wait for it to settle, then try again.";
    case "USER_EOA_MISSING":      return "Your wallet isn't ready yet. Open the mini app once and try again.";
    case "POLYMARKET_CREDS_KEY_MISSING":
      return "Betting isn't fully configured on this build. Try again later.";
    default:
      return "Couldn't start the bet. Please try again.";
  }
}
