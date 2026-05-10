import { InlineKeyboard } from "grammy";
import { PREDICTION_MARKETS_ENV } from "../../../../helpers/env/predictionMarketEnv";
import { MINI_APP_URL } from "../../../../helpers/env/telegramEnv";
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
import type { IPredictionMarketRepository } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketRepository";

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
  | { kind: "cancel"; intentId: string }
  | { kind: "cancel_executing"; intentId: string };

const CALLBACK_PREFIXES = ["place_bet", "confirm_bet", "cancel_bet", "cancel_executing"] as const;
const CENTS_PER_USDC = 100;

/**
 * Callback layout: `place_bet:<findingId>:<side>`. The marketId is NOT in the
 * payload — Telegram caps callback_data at 64 bytes and Polymarket condition
 * ids alone are 66, so we resolve the marketId server-side by reading the
 * persisted finding row and selecting `sideA.marketId` / `sideB.marketId`.
 */
const PLACE_BET_RX = /^place_bet:([^:]+):(A|B)$/;

export class PlaceBetCapability implements Capability<PlaceBetParams> {
  readonly id = "place_bet";
  readonly triggers: TriggerSpec = {
    callbackPrefix: [...CALLBACK_PREFIXES],
  };

  constructor(
    private readonly betUseCase: IPredictionMarketBetUseCase,
    private readonly findingRepo: IPredictionMarketRepository,
  ) {}

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
        const [, findingId, side] = placeMatch;
        const finding = await this.findingRepo.getFinding(findingId!);
        if (!finding) {
          log.warn(
            { userId: ctx.userId, findingId, side, step: "finding-not-found" },
            "place-bet",
          );
          return terminalChat("That finding has expired. Tap a side on a fresh card to start over.");
        }
        const marketId = side === "A" ? finding.sideA.marketId : finding.sideB.marketId;
        const result = await this.betUseCase.initiateBetIntent({
          userId: ctx.userId,
          findingId: findingId!,
          marketId,
          side: side!,
          outcomeTokenId: null,
          refPriceBps: null,
        });
        // Re-tap recovery: `initiateBetIntent` reuses any active intent, which
        // may already be past `awaiting_amount` (e.g. user typed an amount but
        // never saw the confirm card). Re-emit the appropriate artifact for
        // the intent's current status instead of blindly re-asking for amount.
        if (result.intent.status === "awaiting_confirm" && result.intent.stakeUsdcCents != null) {
          const stakeUsdc = result.intent.stakeUsdcCents / CENTS_PER_USDC;
          log.info(
            { userId: ctx.userId, intentId: result.intent.id, step: "reshow-confirm" },
            "place-bet",
          );
          return {
            kind: "terminal",
            artifact: confirmCardArtifact(result.intent, stakeUsdc),
          };
        }
        if (result.intent.status === "executing") {
          log.info(
            { userId: ctx.userId, intentId: result.intent.id, step: "reshow-executing" },
            "place-bet",
          );
          return {
            kind: "terminal",
            artifact: executingArtifact(result.intent.id),
          };
        }
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

      const cancelExecutingMatch = data.match(/^cancel_executing:([0-9a-f-]+)$/);
      if (cancelExecutingMatch) {
        return { kind: "ok", params: { kind: "cancel_executing", intentId: cancelExecutingMatch[1]! } };
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
        await this.betUseCase.confirmBetIntent({
          userId: ctx.userId,
          intentId: params.intentId,
          clientOrderId: newUuid(),
        });
        // Deep-link target is the *intentId*, not the betId — the FE
        // PlaceBetHandler is keyed off intentId (`place_bet:<intentId>` per
        // fe/.../utils/deepLink.ts) and looks up the bet via `pmApi.intent`.
        return openMiniAppArtifact(params.intentId);
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

    if (params.kind === "cancel") {
      await this.betUseCase.cancelBetIntent(ctx.userId, params.intentId);
      return resultArtifact({
        status: "success",
        verb: "prediction_market_bet_failed",
        headline: "Bet cancelled",
        fields: [{ label: "Status", value: "Intent dropped." }],
        complexity: "simple",
      });
    }

    // params.kind === "cancel_executing"
    await this.betUseCase.cancelExecutingIntent(ctx.userId, params.intentId);
    return resultArtifact({
      status: "success",
      verb: "prediction_market_bet_failed",
      headline: "Stuck bet cleared",
      fields: [
        { label: "Status", value: "Intent cancelled and bet marked failed." },
        { label: "Next", value: "Tap a side on a finding card to place a fresh bet." },
      ],
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
    // `pending` (not `preview`) — the Telegram renderer drops preview cards
    // by design (they belong to the mini-app surface). This card IS the
    // user-facing confirm step on the chat surface, so it must render.
    status: "pending",
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

function openMiniAppArtifact(intentId: string): Artifact {
  const text = `Bet started. Open the mini app to finish placing it (intent id \`${intentId.slice(0, 8)}…\`).`;
  // FE deeplink contract: read from `?startapp=` (URL fallback) or Telegram
  // `start_param` — see fe/.../utils/deepLink.ts. Without MINI_APP_URL we
  // can only emit a plain message; a callback button would be a no-op
  // because nothing handles `open_app:*` callbacks.
  if (!MINI_APP_URL) {
    return { kind: "chat", text, parseMode: "Markdown" };
  }
  const url = `${MINI_APP_URL}?startapp=place_bet:${intentId}`;
  return {
    kind: "chat",
    text,
    parseMode: "Markdown",
    keyboard: new InlineKeyboard().webApp("Open mini app", url),
  };
}

/**
 * Re-emitted when a user re-taps a finding side after their previous intent
 * has reached `executing` but the bet was never finished (typical cause: the
 * mini-app deeplink was broken or the user closed the FE mid-flow). Two
 * buttons: resume in the mini-app, or cancel the stuck intent + bet so the
 * user can place a fresh bet.
 */
function executingArtifact(intentId: string): Artifact {
  const text =
    `You already have a bet being processed (intent \`${intentId.slice(0, 8)}…\`). ` +
    `Open the mini app to finish it, or cancel it to start a new bet.`;
  const cancelButtonRow = new InlineKeyboard().text(
    "Cancel & start over",
    `cancel_executing:${intentId}`,
  );
  if (!MINI_APP_URL) {
    return { kind: "chat", text, parseMode: "Markdown", keyboard: cancelButtonRow };
  }
  const url = `${MINI_APP_URL}?startapp=place_bet:${intentId}`;
  const keyboard = new InlineKeyboard()
    .webApp("Open mini app", url)
    .row()
    .text("Cancel & start over", `cancel_executing:${intentId}`);
  return { kind: "chat", text, parseMode: "Markdown", keyboard };
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
