import type Redis from "ioredis";
import pLimit from "p-limit";
import { encodeFunctionData, erc20Abi } from "viem";
import { aesEncrypt } from "../../helpers/crypto/aesGcm";
import { PREDICTION_MARKETS_ENV } from "../../helpers/env/predictionMarketEnv";
import { deriveScaAddress } from "../../helpers/deriveScaAddress";
import { getPolymarketConfig, getUsdcAddress } from "../../helpers/chainConfig";
import { createLogger } from "../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import type {
  IPolymarketAdapter,
  PolymarketCreds,
  PolymarketPositionView,
} from "../interface/predictionMarket/IPolymarketAdapter";
import {
  SETUP_STEPS,
  type BetIntentRow,
  type BetRow,
  type BetStatus,
  type IPredictionMarketBetRepository,
  type PositionRow,
  type SetupStep,
  type UserSetupRow,
} from "../interface/predictionMarket/IPredictionMarketBetRepository";
import type { ISigningRequestUseCase } from "../interface/input/signingRequest.interface";
import type { IMiniAppRequestCache } from "../interface/output/cache/miniAppRequest.cache";
import type { SignRequest } from "../interface/output/cache/miniAppRequest.types";
import type {
  Eip712Purpose,
  SigningRequestKind,
  SigningRequestRecord,
} from "../interface/output/cache/signingRequest.cache";
import {
  buildPolymarketOrderMessage,
  POLYMARKET_CLOB_AUTH_MESSAGE,
  POLYMARKET_CLOB_AUTH_TYPES,
  POLYMARKET_ORDER_TYPES,
  polymarketClobAuthDomain,
  polymarketOrderDomain,
} from "../interface/predictionMarket/polymarketOrderDomain";
import type {
  ConfirmBetIntentInput,
  FinalizeBetInput,
  InitiateCloseInput,
  IPredictionMarketBetUseCase,
  InitiateBetIntentInput,
  InitiateBetIntentResult,
  ReconcileResult,
  SetupArtifact,
  SubmitAmountInput,
  SubmitAmountResult,
} from "../interface/predictionMarket/IPredictionMarketBetUseCase";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";

const log = createLogger("predictionMarketBetUseCase");

const CENTS_PER_USDC = 100;
const BPS_PER_UNIT = 10_000;

const SETUP_STEP_ORDER: Readonly<Record<SetupStep, number>> = (() => {
  const map = {} as Record<SetupStep, number>;
  SETUP_STEPS.forEach((s, i) => { map[s] = i; });
  return map;
})();

/** Decimal-string subtraction without intermediate float collapse. */
function subtractShares(total: string, delta: string): string {
  // Use Number for the JS view; sizes are bounded (Polymarket max share count
  // per user trades is well under Number.MAX_SAFE_INTEGER even at 6 dp).
  const t = Number(total);
  const d = Number(delta);
  if (!Number.isFinite(t) || !Number.isFinite(d)) return total;
  const remaining = Math.max(0, t - d);
  return remaining.toFixed(6).replace(/\.?0+$/, "");
}

// Sign-request TTL for bet-driven enqueues (seconds). The mini-app polls for
// the next pending sign within this window; the stuck-bet sweeper picks up
// the slack after a longer `stuckBetTimeoutMs` once the row has expired.
const BET_SIGN_REQUEST_TTL_SEC = 10 * 60;

// Fan-out cap on a single sweeper tick. Matches the position poller's bounded
// concurrency pattern.
const SWEEPER_CONCURRENCY = 10;

// Redis NX-lock TTL guarding "one open sign-request per (bet, slot)" so a
// double advance call doesn't enqueue twice. Slightly longer than the
// sign-request TTL so the lock can't expire while the request is still live.
const ENQUEUE_LOCK_TTL_SEC = 11 * 60;

export class PredictionMarketBetUseCase implements IPredictionMarketBetUseCase {
  // Deps for the 2026-05-15 advance() driver. Optional so the legacy chat
  // flow (and tests that don't exercise advance()) can construct the use
  // case without the sign-queue surface wired. When `useSignQueue` is true
  // but a dep is missing, advance() logs and exits — it never throws into
  // callers that are merely on the legacy path.
  //
  // signingRequestUseCase is fetched via a getter to break the circular
  // dep between it and this use case (signingRequest needs to fan
  // /response events into notifySignResolved here, but this use case
  // needs signingRequest.create() to enqueue work).
  private readonly getSigningRequestUseCase?: () => ISigningRequestUseCase | undefined;
  private readonly miniAppRequestCache?: IMiniAppRequestCache;
  private readonly redis?: Redis;
  private readonly useSignQueue: boolean;
  private readonly chatIdResolver?: (userId: string) => Promise<number | null>;

  constructor(
    private readonly repo: IPredictionMarketBetRepository,
    private readonly userProfileDB: IUserProfileDB,
    private readonly polymarketAdapter: IPolymarketAdapter,
    signQueueDeps?: {
      getSigningRequestUseCase: () => ISigningRequestUseCase | undefined;
      miniAppRequestCache: IMiniAppRequestCache;
      redis: Redis;
      useSignQueue: boolean;
      // Resolves a user's telegramChatId for the SigningRequestRecord. The
      // legacy chat flow gets this from a telegram-session lookup; we hand
      // the same lookup in via a closure to avoid pulling another sql repo
      // dep into this use case.
      chatIdResolver: (userId: string) => Promise<number | null>;
    },
  ) {
    this.getSigningRequestUseCase = signQueueDeps?.getSigningRequestUseCase;
    this.miniAppRequestCache = signQueueDeps?.miniAppRequestCache;
    this.redis = signQueueDeps?.redis;
    this.useSignQueue = signQueueDeps?.useSignQueue ?? false;
    this.chatIdResolver = signQueueDeps?.chatIdResolver;
  }

  // ── Setup ──────────────────────────────────────────────────────────────

  async ensureUserSetup(userId: string): Promise<UserSetupRow> {
    const existing = await this.repo.getUserSetup(userId);
    if (existing) return existing;

    const profile = await this.userProfileDB.findByUserId(userId);
    if (!profile?.eoaAddress) {
      throw new Error("USER_EOA_MISSING");
    }
    const polygonScaAddress = await deriveScaAddress(
      profile.eoaAddress as `0x${string}`,
      PREDICTION_MARKETS_ENV.betChainId,
    );
    const now = newCurrentUTCEpoch();
    const row: UserSetupRow = {
      userId,
      polygonScaAddress,
      polygonEoaAddress: profile.eoaAddress,
      bootstrapBridgeIntentId: null,
      approvalsTxHashes: null,
      polymarketCredsEnc: null,
      setupStep: "pending",
      createdAtEpoch: now,
      updatedAtEpoch: now,
    };
    await this.repo.upsertUserSetup(row);
    log.info({ userId, polygonScaAddress, step: "setup-initialized" }, "ensure-user-setup");
    return row;
  }

  async recordSetupStep(
    userId: string,
    step: SetupStep,
    artifact?: SetupArtifact,
  ): Promise<UserSetupRow> {
    const setup = await this.ensureUserSetup(userId);
    // Setup is monotonically forward — we never go backwards (a re-confirm is
    // a no-op). Skipping ahead is also rejected: each step's artifact is a
    // precondition for the next one, so a FE call that jumps `pending →
    // approved` would leave us with no `bootstrapBridgeIntentId`. Re-running
    // the same step is allowed (idempotency) so we can reapply artifacts.
    const curIdx = SETUP_STEP_ORDER[setup.setupStep];
    const nextIdx = SETUP_STEP_ORDER[step];
    if (nextIdx < curIdx) {
      log.warn({ userId, step, prevStep: setup.setupStep }, "setup-step-backwards-rejected");
      throw new Error(`SETUP_STEP_BACKWARDS:${setup.setupStep}->${step}`);
    }
    if (nextIdx > curIdx + 1) {
      log.warn({ userId, step, prevStep: setup.setupStep }, "setup-step-skip-rejected");
      throw new Error(`SETUP_STEP_SKIP:${setup.setupStep}->${step}`);
    }
    if (artifact?.bridgeIntentId) {
      await this.repo.setBootstrapBridgeIntentId(userId, artifact.bridgeIntentId);
    }
    if (artifact?.approvalsTxHashes && artifact.approvalsTxHashes.length > 0) {
      await this.repo.setApprovalsTxHashes(userId, artifact.approvalsTxHashes);
    }
    if (step !== setup.setupStep) {
      await this.repo.updateSetupStep(userId, step);
      log.info({ userId, step, prevStep: setup.setupStep }, "setup-step-recorded");
    }
    const fresh = await this.repo.getUserSetup(userId);
    return fresh!;
  }

  async storePolymarketCreds(userId: string, creds: PolymarketCreds): Promise<void> {
    const keyHex = PREDICTION_MARKETS_ENV.credsKeyHex;
    if (!keyHex) {
      log.error({ userId }, "store-creds-missing-key");
      throw new Error("POLYMARKET_CREDS_KEY_MISSING");
    }
    const envelope = aesEncrypt(JSON.stringify(creds), keyHex);
    await this.repo.setPolymarketCredsEnc(userId, envelope);
    await this.repo.updateSetupStep(userId, "authed");
    log.info({ userId, step: "creds-stored" }, "polymarket-auth");
  }

  // ── Intent lifecycle ───────────────────────────────────────────────────

  async initiateBetIntent(input: InitiateBetIntentInput): Promise<InitiateBetIntentResult> {
    const setup = await this.repo.getUserSetup(input.userId);
    const needsSetup = !setup || setup.setupStep !== "complete";

    const existing = await this.repo.findActiveIntentForUser(input.userId);
    if (existing) {
      log.info(
        { userId: input.userId, intentId: existing.id, step: "active-intent-reused" },
        "place-bet",
      );
      return {
        intent: existing,
        setup,
        needsSetup,
        minStakeUsdc: PREDICTION_MARKETS_ENV.minStakeUsdc,
        maxStakeUsdc: PREDICTION_MARKETS_ENV.maxStakeUsdc,
      };
    }

    const intent = await this.repo.insertBetIntent({
      id: newUuid(),
      userId: input.userId,
      findingId: input.findingId,
      marketId: input.marketId,
      side: input.side,
      outcomeTokenId: input.outcomeTokenId,
      refPriceBps: input.refPriceBps,
      expiresAtEpoch: Math.floor(Date.now() / 1000) + Math.floor(PREDICTION_MARKETS_ENV.betIntentTtlMs / 1000),
    });
    log.info(
      {
        userId: input.userId,
        intentId: intent.id,
        findingId: input.findingId,
        side: input.side,
        step: "started",
      },
      "place-bet",
    );
    return {
      intent,
      setup,
      needsSetup,
      minStakeUsdc: PREDICTION_MARKETS_ENV.minStakeUsdc,
      maxStakeUsdc: PREDICTION_MARKETS_ENV.maxStakeUsdc,
    };
  }

  async submitAmount(input: SubmitAmountInput): Promise<SubmitAmountResult> {
    const intent = await this.repo.getBetIntent(input.intentId);
    if (!intent || intent.userId !== input.userId) return { kind: "rejected", reason: "not-found" };
    if (intent.status !== "awaiting_amount") return { kind: "rejected", reason: "wrong-status" };
    if (input.stakeUsdc < PREDICTION_MARKETS_ENV.minStakeUsdc) {
      return { kind: "rejected", reason: "below-min" };
    }
    if (input.stakeUsdc > PREDICTION_MARKETS_ENV.maxStakeUsdc) {
      return { kind: "rejected", reason: "above-max" };
    }
    const cents = Math.round(input.stakeUsdc * CENTS_PER_USDC);
    await this.repo.setBetIntentAmount(input.intentId, cents);
    const fresh = await this.repo.getBetIntent(input.intentId);
    log.info(
      {
        userId: input.userId,
        intentId: input.intentId,
        stakeUsdc: input.stakeUsdc,
        step: "amount-received",
      },
      "place-bet",
    );
    return { kind: "ok", intent: fresh! };
  }

  async confirmBetIntent(input: ConfirmBetIntentInput): Promise<BetRow> {
    const intent = await this.repo.getBetIntent(input.intentId);
    if (!intent || intent.userId !== input.userId) {
      throw new Error("INTENT_NOT_FOUND");
    }
    if (intent.status !== "awaiting_confirm") {
      throw new Error(`INTENT_WRONG_STATUS:${intent.status}`);
    }
    if (intent.stakeUsdcCents == null) {
      throw new Error("INTENT_INCOMPLETE");
    }
    // One in-flight bet per user. PARTIAL counts as in-flight because the
    // residual-funds refund UserOp must complete before the next bet drains
    // SCA→EOA again — otherwise the refund races with the new transfer.
    const inFlight = await this.repo.countOpenBetsForUser(input.userId);
    if (inFlight > 0) {
      log.warn({ userId: input.userId, inFlight, intentId: input.intentId }, "bet-rejected-in-flight");
      throw new Error("BET_IN_FLIGHT");
    }
    const bet = await this.repo.insertBet({
      id: newUuid(),
      userId: input.userId,
      intentId: intent.id,
      findingId: intent.findingId,
      marketId: intent.marketId,
      outcomeTokenId: intent.outcomeTokenId,
      side: intent.side,
      stakeUsdcCents: intent.stakeUsdcCents,
      refPriceBps: intent.refPriceBps,
      clientOrderId: input.clientOrderId,
      betKind: "open",
      parentBetId: null,
    });
    await this.repo.setBetIntentStatus(intent.id, "executing", bet.id);
    log.info(
      { userId: input.userId, intentId: intent.id, betId: bet.id, step: "confirmed" },
      "place-bet",
    );
    // Slice D cutover: drive setup-then-bet via the sign queue. Single
    // fetch — if setup is already complete, kick the bet directly;
    // otherwise let setupAdvance enqueue the first setup step and rely
    // on the authed→complete bridge in setupAdvance to kick the bet.
    if (this.useSignQueue) {
      const setup = await this.repo.getUserSetup(input.userId);
      if (setup?.setupStep === "complete") {
        await this.advance(bet.id);
      } else {
        await this.setupAdvance(input.userId);
      }
    }
    return bet;
  }

  async cancelBetIntent(userId: string, intentId: string): Promise<void> {
    const intent = await this.repo.getBetIntent(intentId);
    if (!intent || intent.userId !== userId) return;
    await this.repo.setBetIntentStatus(intentId, "cancelled");
    log.info({ userId, intentId, step: "cancelled" }, "place-bet");
  }

  async cancelExecutingIntent(userId: string, intentId: string): Promise<void> {
    const intent = await this.repo.getBetIntent(intentId);
    if (!intent || intent.userId !== userId) return;
    if (intent.status !== "executing") return;
    if (intent.betId) {
      try {
        await this.repo.setBetFailure(intent.betId, "manual-cancel");
      } catch (err) {
        // Bet may already be terminal (FILLED/UNFILLED/FAILED) — log and
        // continue so the intent still gets cancelled. The whole point of
        // this method is to unstick the chat surface.
        log.warn(
          { err, userId, intentId, betId: intent.betId, step: "manual-cancel-bet-failed" },
          "place-bet",
        );
      }
    }
    await this.repo.setBetIntentStatus(intentId, "cancelled");
    log.info(
      { userId, intentId, betId: intent.betId, step: "manual-cancel" },
      "place-bet",
    );
  }

  async transitionBet(
    userId: string,
    betId: string,
    status: BetStatus,
    patch: { bridgeIntentId?: string; scaToEoaTxHash?: string; polymarketOrderId?: string } = {},
  ): Promise<BetRow> {
    const bet = await this.repo.getBet(betId);
    if (!bet || bet.userId !== userId) throw new Error("BET_NOT_FOUND");
    await this.repo.updateBetStatus(betId, status, patch);
    const fresh = await this.repo.getBet(betId);
    log.info(
      {
        userId,
        betId,
        step: status.toLowerCase().replace(/_/g, "-"),
        ...(patch.bridgeIntentId ? { bridgeIntentId: patch.bridgeIntentId } : {}),
        ...(patch.scaToEoaTxHash ? { txHash: patch.scaToEoaTxHash } : {}),
        ...(patch.polymarketOrderId ? { polymarketOrderId: patch.polymarketOrderId } : {}),
      },
      "place-bet",
    );
    return fresh!;
  }

  async getBet(userId: string, betId: string): Promise<BetRow | null> {
    const bet = await this.repo.getBet(betId);
    if (!bet || bet.userId !== userId) return null;
    return bet;
  }

  async getActiveIntent(userId: string): Promise<BetIntentRow | null> {
    return this.repo.findActiveIntentForUser(userId);
  }

  async getBetIntent(userId: string, intentId: string): Promise<BetIntentRow | null> {
    const intent = await this.repo.getBetIntent(intentId);
    if (!intent || intent.userId !== userId) return null;
    return intent;
  }

  async listOpenPositions(userId: string): Promise<PositionRow[]> {
    return this.repo.listOpenPositionsForUser(userId);
  }

  async finalizeBet(
    input: FinalizeBetInput,
  ): Promise<{ bet: BetRow; position: PositionRow | null; closedPosition: PositionRow | null }> {
    const bet = await this.repo.getBet(input.betId);
    if (!bet || bet.userId !== input.userId) throw new Error("BET_NOT_FOUND");

    if (input.outcome === "FAILED") {
      await this.repo.setBetFailure(bet.id, input.failureReason ?? "unknown");
      if (bet.intentId) await this.repo.setBetIntentStatus(bet.intentId, "failed");
      // If USDC was already transferred SCA→EOA (sca_to_eoa_tx_hash set) but
      // the order never matched, the funds sit on the EOA awaiting a refund
      // UserOp. Mark refundRequired so the mini-app's resume path picks it up.
      if (bet.scaToEoaTxHash && bet.betKind === "open") {
        await this.repo.setBetRefundRequired(bet.id, true);
      }
      // For a close that failed, the position stays in `closing` until a retry
      // or manual reset; we don't roll it back to `open` blindly because the
      // sell-side order may have partially filled before the failure was reported.
      log.error(
        { userId: bet.userId, betId: bet.id, failureReason: input.failureReason, step: "failed" },
        "place-bet",
      );
      const fresh = await this.repo.getBet(bet.id);
      return { bet: fresh!, position: null, closedPosition: null };
    }

    await this.repo.updateBetStatus(bet.id, input.outcome, {
      filledShares: input.filledShares,
      filledAvgPriceBps: input.filledAvgPriceBps,
    });

    // PARTIAL/UNFILLED on an open bet leaves residual USDC on the EOA. Mark
    // it for refund so the mini-app sweeps it back to the SCA on next open.
    // (FILLED converts the USDC into outcome tokens; no residual to refund.)
    const stakeArrivedOnEoa = bet.scaToEoaTxHash != null;
    const isOpenWithResidual =
      bet.betKind === "open" &&
      stakeArrivedOnEoa &&
      (input.outcome === "PARTIAL" || input.outcome === "UNFILLED");
    if (isOpenWithResidual) {
      await this.repo.setBetRefundRequired(bet.id, true);
    }

    let position: PositionRow | null = null;
    let closedPosition: PositionRow | null = null;
    const fillPriceBps = input.filledAvgPriceBps ?? bet.refPriceBps;

    const filledQty = input.filledShares ? Number(input.filledShares) : 0;
    const isFilledOrPartial = input.outcome === "FILLED" || input.outcome === "PARTIAL";

    if (isFilledOrPartial && filledQty > 0 && bet.betKind === "open") {
      if (bet.outcomeTokenId !== null && fillPriceBps !== null) {
        const row: PositionRow = {
          id: newUuid(),
          userId: bet.userId,
          marketId: bet.marketId,
          outcomeTokenId: bet.outcomeTokenId,
          side: bet.side,
          sizeShares: input.filledShares!,
          entryPriceAvgBps: fillPriceBps,
          entryStakeUsdcCents: bet.stakeUsdcCents,
          openingBetId: bet.id,
          closingBetId: null,
          currentValueUsdcCents: null,
          status: "open",
          resolvedOutcome: null,
          realizedPnlUsdcCents: null,
          openedAtEpoch: newCurrentUTCEpoch(),
          closedAtEpoch: null,
        };
        await this.repo.insertPosition(row);
        position = row;
      }
    }

    if (isFilledOrPartial && bet.betKind === "close") {
      const parent = await this.repo.findPositionByClosingBetId(bet.id);
      if (parent && fillPriceBps !== null && filledQty > 0) {
        // Realized PnL = exit notional − entry notional (proportional to closed shares).
        const exitCents = Math.round(filledQty * (fillPriceBps / BPS_PER_UNIT) * CENTS_PER_USDC);
        const entryNotionalCents = Math.round(
          filledQty * (parent.entryPriceAvgBps / BPS_PER_UNIT) * CENTS_PER_USDC,
        );
        const pnlCents = exitCents - entryNotionalCents;
        const isFullClose = input.outcome === "FILLED";
        if (isFullClose) {
          await this.repo.updatePositionStatus(parent.id, "closed", {
            realizedPnlUsdcCents: (parent.realizedPnlUsdcCents ?? 0) + pnlCents,
            closedAtEpoch: newCurrentUTCEpoch(),
          });
        } else {
          // Partial close: decrement remaining shares by the filled quantity
          // and reopen the position so the user can close the rest later.
          // Without this decrement the local row still claimed the original
          // share count, double-counting on the next reconcile/close cycle.
          const remaining = subtractShares(parent.sizeShares, input.filledShares!);
          if (Number(remaining) <= 0) {
            await this.repo.updatePositionStatus(parent.id, "closed", {
              realizedPnlUsdcCents: (parent.realizedPnlUsdcCents ?? 0) + pnlCents,
              closedAtEpoch: newCurrentUTCEpoch(),
            });
          } else {
            await this.repo.decrementPositionShares(parent.id, input.filledShares!);
            await this.repo.updatePositionStatus(parent.id, "open", {
              realizedPnlUsdcCents: (parent.realizedPnlUsdcCents ?? 0) + pnlCents,
              closingBetId: null,
              closedAtEpoch: null,
            });
          }
        }
        const fresh = await this.repo.getPosition(parent.id);
        closedPosition = fresh ?? parent;
      }
    }

    if (bet.intentId) {
      await this.repo.setBetIntentStatus(bet.intentId, "completed");
    }
    log.info(
      {
        userId: bet.userId,
        betId: bet.id,
        outcome: input.outcome,
        filledShares: input.filledShares,
        filledAvgPriceBps: input.filledAvgPriceBps,
        betKind: bet.betKind,
        step: input.outcome === "FILLED" ? "filled" : input.outcome.toLowerCase(),
      },
      "place-bet",
    );
    const freshBet = await this.repo.getBet(bet.id);
    return { bet: freshBet!, position, closedPosition };
  }

  // ── Close-position flow ─────────────────────────────────────────────────

  async previewClose(
    userId: string,
    positionId: string,
  ): Promise<{
    position: PositionRow;
    bestBidPriceBps: number;
    estProceedsUsdcCents: number;
    estPnlUsdcCents: number;
  } | null> {
    const position = await this.repo.getPosition(positionId);
    if (!position || position.userId !== userId || position.status !== "open") return null;
    const tob = await this.polymarketAdapter.getOrderbookTopOfBook(position.outcomeTokenId);
    const bestBidPriceBps = Math.round(tob.bestBidPrice * BPS_PER_UNIT);
    const sizeQty = Number(position.sizeShares);
    const estProceedsUsdcCents = Math.round(
      sizeQty * tob.bestBidPrice * CENTS_PER_USDC,
    );
    const estPnlUsdcCents = estProceedsUsdcCents - position.entryStakeUsdcCents;
    log.debug(
      { userId, positionId, bestBidPriceBps, estProceedsUsdcCents, estPnlUsdcCents },
      "close-preview",
    );
    return { position, bestBidPriceBps, estProceedsUsdcCents, estPnlUsdcCents };
  }

  async initiateClose(input: InitiateCloseInput): Promise<BetRow> {
    const position = await this.repo.getPosition(input.positionId);
    if (!position || position.userId !== input.userId) {
      throw new Error("POSITION_NOT_FOUND");
    }
    if (position.status !== "open") {
      throw new Error(`POSITION_WRONG_STATUS:${position.status}`);
    }
    const bet = await this.repo.insertBet({
      id: newUuid(),
      userId: input.userId,
      intentId: null,
      findingId: null,
      marketId: position.marketId,
      outcomeTokenId: position.outcomeTokenId,
      side: position.side,
      // Stake for a close is the *expected proceeds*, used only as a logging
      // hint. The actual amount is determined by the FE-signed sell order.
      stakeUsdcCents: Math.max(
        1,
        Math.round(
          Number(position.sizeShares) * (input.refPriceBps / BPS_PER_UNIT) * CENTS_PER_USDC,
        ),
      ),
      refPriceBps: input.refPriceBps,
      clientOrderId: input.clientOrderId,
      betKind: "close",
      parentBetId: position.openingBetId,
    });
    await this.repo.updatePositionStatus(position.id, "closing", { closingBetId: bet.id });
    log.info(
      { userId: input.userId, positionId: position.id, betId: bet.id, step: "close-confirmed" },
      "close-position",
    );
    // Close path: setup is already complete (the user has an open position).
    // For closes the SCA→EOA transfer is unnecessary — the shares are already
    // on the SCA, and the order-sign step is where the sell happens. Skip
    // straight to ORDER_SUBMITTED enqueue by bumping past SCA_TO_EOA.
    if (this.useSignQueue) {
      try {
        await this.repo.updateBetStatus(bet.id, "SCA_TO_EOA", {});
      } catch (err) {
        log.warn({ err, betId: bet.id, step: "close-presubmit-bump-failed" }, "close-position");
      }
      await this.advance(bet.id);
    }
    return bet;
  }

  // ── Position reconciliation (called by poller) ──────────────────────────

  async reconcileUserPositions(input: {
    userId: string;
    makerAddress: `0x${string}`;
    polymarketCredsEnc: string;
  }): Promise<ReconcileResult> {
    const start = Date.now();
    const local = await this.repo.listOpenPositionsForUser(input.userId);
    if (local.length === 0) return { resolved: [], marked: [], closedFromPolymarket: [] };

    let remote: PolymarketPositionView[];
    try {
      remote = await this.polymarketAdapter.getPositions({
        makerAddress: input.makerAddress,
        polymarketCredsEnc: input.polymarketCredsEnc,
      });
    } catch (err) {
      log.warn({ err, userId: input.userId }, "reconcile-fetch-failed");
      return { resolved: [], marked: [], closedFromPolymarket: [] };
    }
    const remoteByToken = new Map<string, PolymarketPositionView>(
      remote.map((r) => [r.outcomeTokenId, r]),
    );

    const resolved: PositionRow[] = [];
    const marked: PositionRow[] = [];
    const closedFromPolymarket: PositionRow[] = [];

    for (const pos of local) {
      const r = remoteByToken.get(pos.outcomeTokenId);
      if (!r) {
        // Polymarket no longer reports the holding — settle locally as `closed`
        // with whatever realized PnL we already have. Manual close via web,
        // typically.
        if (pos.status === "open") {
          await this.repo.updatePositionStatus(pos.id, "closed", {
            closedAtEpoch: newCurrentUTCEpoch(),
          });
          const fresh = await this.repo.getPosition(pos.id);
          if (fresh) closedFromPolymarket.push(fresh);
        }
        continue;
      }
      if (r.resolved && pos.status !== "resolved") {
        await this.repo.updatePositionStatus(pos.id, "resolved", {
          resolvedOutcome: r.resolvedOutcome,
          realizedPnlUsdcCents: r.realizedPnlUsdcCents,
          closedAtEpoch: newCurrentUTCEpoch(),
        });
        const fresh = await this.repo.getPosition(pos.id);
        if (fresh) resolved.push(fresh);
        continue;
      }
      if (
        r.currentValueUsdcCents !== null &&
        r.currentValueUsdcCents !== pos.currentValueUsdcCents
      ) {
        await this.repo.updatePositionStatus(pos.id, pos.status, {
          currentValueUsdcCents: r.currentValueUsdcCents,
        });
        const fresh = await this.repo.getPosition(pos.id);
        if (fresh) marked.push(fresh);
      }
    }

    log.info(
      {
        step: "tick-end",
        userId: input.userId,
        positionsChecked: local.length,
        resolved: resolved.length,
        marked: marked.length,
        closedFromPolymarket: closedFromPolymarket.length,
        durationMs: Date.now() - start,
      },
      "reconcile-positions",
    );
    return { resolved, marked, closedFromPolymarket };
  }

  async reportPriceDrift(input: {
    userId: string;
    betId: string;
    livePriceBps: number;
  }): Promise<
    | { decision: "ok" }
    | { decision: "reconfirm"; previousRefPriceBps: number; newRefPriceBps: number; driftBps: number }
  > {
    const bet = await this.repo.getBet(input.betId);
    if (!bet || bet.userId !== input.userId) throw new Error("BET_NOT_FOUND");
    const ref = bet.refPriceBps;
    if (ref == null) {
      // No prior reference; whatever the FE sees is the new ref. Accept silently.
      return { decision: "ok" };
    }
    const drift = Math.abs(input.livePriceBps - ref);
    if (drift <= PREDICTION_MARKETS_ENV.maxOrderDriftBps) {
      log.debug(
        { userId: input.userId, betId: input.betId, ref, livePriceBps: input.livePriceBps, drift },
        "drift-within-tolerance",
      );
      return { decision: "ok" };
    }
    log.warn(
      {
        userId: input.userId,
        betId: input.betId,
        previousRefPriceBps: ref,
        newRefPriceBps: input.livePriceBps,
        driftBps: drift,
        step: "drift-detected",
      },
      "place-bet",
    );
    return {
      decision: "reconfirm",
      previousRefPriceBps: ref,
      newRefPriceBps: input.livePriceBps,
      driftBps: drift,
    };
  }

  async recordRefundTxHash(userId: string, betId: string, txHash: string): Promise<BetRow> {
    const bet = await this.repo.getBet(betId);
    if (!bet || bet.userId !== userId) throw new Error("BET_NOT_FOUND");
    if (!bet.refundRequired) {
      log.warn({ userId, betId }, "refund-tx-recorded-without-flag");
    }
    await this.repo.setBetRefundTxHash(betId, txHash);
    log.info({ userId, betId, txHash, step: "refund-recorded" }, "place-bet");
    const fresh = await this.repo.getBet(betId);
    return fresh!;
  }

  // ── 2026-05-15 zero-sign bet rewrite (Slice B) ────────────────────────────

  async advance(betId: string): Promise<void> {
    if (!this.useSignQueue) return;
    if (!this.miniAppRequestCache || !this.redis || !this.getSigningRequestUseCase) {
      log.warn({ betId, step: "advance-skipped-deps-missing" }, "place-bet");
      return;
    }
    const bet = await this.repo.getBet(betId);
    if (!bet) {
      log.warn({ betId, step: "advance-bet-not-found" }, "place-bet");
      return;
    }
    if (bet.status === "FILLED" || bet.status === "FAILED") return;
    if (
      (bet.status === "UNFILLED" || bet.status === "PARTIAL") &&
      (!bet.refundRequired || bet.refundTxHash)
    ) {
      return;
    }

    // Slice C will rewrite setup to advance through here too; until then we
    // refuse to drive a bet whose setup didn't finish on the legacy path.
    const setup = await this.repo.getUserSetup(bet.userId);
    if (!setup || setup.setupStep !== "complete" || !setup.polymarketCredsEnc) {
      log.info(
        { betId, userId: bet.userId, setupStep: setup?.setupStep, step: "advance-setup-incomplete" },
        "place-bet",
      );
      return;
    }

    switch (bet.status) {
      case "INITIATED":
      case "BRIDGING":
      case "BRIDGED":
        return this.enqueueScaToEoa(bet, setup);
      case "SCA_TO_EOA":
        return this.enqueueOrderSign(bet, setup);
      case "ORDER_SIGNED":
      case "ORDER_SUBMITTED":
        // Position poller is the next mover; no-op so the sweeper doesn't churn.
        return;
      case "PARTIAL":
      case "UNFILLED":
        return this.enqueueResidualSweep(bet, setup);
      default:
        return;
    }
  }

  async notifySignResolved(input: {
    betId: string;
    requestId: string;
    kind: SigningRequestKind;
    purpose?: Eip712Purpose;
    txHash?: string;
    polymarketOrderId?: string;
    rejected: boolean;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    if (!this.useSignQueue) return;
    const bet = await this.repo.getBet(input.betId);
    if (!bet) {
      log.warn({ betId: input.betId, step: "notify-bet-not-found" }, "place-bet");
      return;
    }
    const slot = slotForKind(input.kind, input.purpose);
    // Release the (bet, slot) lock so the sweeper can re-enqueue promptly if
    // this resolution turns out to need a retry — without explicit release
    // the lock sits for ENQUEUE_LOCK_TTL_SEC (≥ sign-request TTL).
    if (slot) await this.releaseEnqueueLock(input.betId, slot);

    if (input.rejected) {
      log.warn(
        {
          betId: input.betId,
          requestId: input.requestId,
          kind: input.kind,
          errorCode: input.errorCode,
          step: "sign-rejected",
        },
        "place-bet",
      );
      // setBetFailure goes through the state-machine guard; PARTIAL/UNFILLED
      // have no legal forward transitions, so calling it on a terminal row
      // (e.g. residual-sweep rejected on an already-PARTIAL bet) throws
      // IllegalBetTransitionError. The sweeper retries each tick, so skip
      // the redundant write rather than logging the same exception forever.
      if (bet.status !== "FILLED" && bet.status !== "FAILED" && bet.status !== "PARTIAL" && bet.status !== "UNFILLED") {
        await this.repo.setBetFailure(input.betId, input.errorCode ?? "sign-rejected");
      }
      return;
    }

    try {
      if (input.kind === "userop" && bet.status !== "SCA_TO_EOA") {
        // Defensive `!==`: the legacy FE-driven path can already have moved
        // the row to SCA_TO_EOA via /transition by the time /response lands.
        // In the pure zero-sign path the status here is always INITIATED.
        await this.repo.updateBetStatus(input.betId, "SCA_TO_EOA", {
          scaToEoaTxHash: input.txHash ?? null,
        });
        log.info(
          { betId: input.betId, txHash: input.txHash, step: "sca-to-eoa" },
          "place-bet",
        );
      } else if (input.kind === "eip712" && input.purpose === "polymarket_order") {
        // Single write: signature was verified at /response time, FE already
        // submitted to CLOB. Two-step (SCA_TO_EOA → ORDER_SIGNED → ORDER_SUBMITTED)
        // would leave the bet stuck at ORDER_SIGNED on second-write failure
        // (advance()'s no-op branch for ORDER_SIGNED would never recover).
        await this.repo.updateBetStatus(input.betId, "ORDER_SUBMITTED", {
          polymarketOrderId: input.polymarketOrderId ?? null,
        });
        log.info(
          {
            betId: input.betId,
            polymarketOrderId: input.polymarketOrderId,
            step: "order-submitted",
          },
          "place-bet",
        );
      } else if (input.kind === "eoa_tx") {
        await this.repo.setBetRefundTxHash(input.betId, input.txHash ?? "");
        log.info(
          { betId: input.betId, txHash: input.txHash, step: "refund-recorded" },
          "place-bet",
        );
        return;
      }
    } catch (err) {
      log.error(
        { err, betId: input.betId, requestId: input.requestId, step: "notify-state-update-failed" },
        "place-bet",
      );
      return;
    }

    await this.advance(input.betId);
  }

  async sweepStuckBets(olderThanEpoch: number): Promise<number> {
    if (!this.useSignQueue) return 0;
    // Bound a single sweep tick; 50/tick is well above realistic concurrent
    // in-flight volume on a 30s cadence.
    const stuck = await this.repo.listStuckBets(olderThanEpoch, 50);
    const limit = pLimit(SWEEPER_CONCURRENCY);
    await Promise.all(
      stuck.map((bet) =>
        limit(async () => {
          try {
            await this.advance(bet.id);
          } catch (err) {
            log.error({ err, betId: bet.id, step: "sweeper-advance-failed" }, "place-bet");
          }
        }),
      ),
    );
    return stuck.length;
  }

  // ── setup state machine (Slice C) ────────────────────────────────────────

  async setupAdvance(userId: string): Promise<void> {
    if (!this.useSignQueue) return;
    if (!this.miniAppRequestCache || !this.redis || !this.getSigningRequestUseCase) return;
    let setup = await this.repo.getUserSetup(userId);
    if (!setup) {
      setup = await this.ensureUserSetup(userId);
    }
    switch (setup.setupStep) {
      case "pending":
        // SCA address is already derived in ensureUserSetup; the legacy
        // "deploy" step is a no-op in the new flow (Kernel SCAs are
        // deploy-on-first-tx, which happens in the gas-funding userop).
        await this.repo.updateSetupStep(userId, "sca_deployed");
        return this.setupAdvance(userId);
      case "sca_deployed":
        return this.enqueueSetupGasFunding(setup);
      case "gas_funded":
        return this.enqueueSetupApprovals(setup);
      case "approved":
        return this.enqueueSetupClobAuth(setup);
      case "authed":
        await this.repo.updateSetupStep(userId, "complete");
        // Setup just landed; if the user has a non-terminal bet that was
        // created mid-setup, kick its first enqueue immediately rather than
        // making them wait for the next stuck-bet sweep tick.
        await this.kickPendingBetsForUser(userId);
        return;
      case "complete":
        return;
    }
  }

  private async kickPendingBetsForUser(userId: string): Promise<void> {
    const bet = await this.repo.findActiveBetForUser(userId);
    if (!bet) return;
    await this.advance(bet.id).catch((err) =>
      log.error({ err, betId: bet.id, step: "kick-after-setup-failed" }, "place-bet"),
    );
  }

  async notifySetupSignResolved(input: {
    userId: string;
    requestId: string;
    kind: SigningRequestKind;
    purpose?: Eip712Purpose;
    txHash?: string;
    rejected: boolean;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    if (!this.useSignQueue) return;
    const setup = await this.repo.getUserSetup(input.userId);
    if (!setup) return;
    if (input.rejected) {
      log.warn(
        { userId: input.userId, requestId: input.requestId, step: "setup-sign-rejected" },
        "setup",
      );
      return;
    }

    // Compute the slot that just resolved BEFORE applying state changes.
    // For approvals we need the index, which is the current
    // approvalsTxHashes length (the slot that was enqueued was index
    // `done` when enqueueSetupApprovals last ran).
    let resolvedSlot: SetupSlot | null = null;
    if (input.kind === "userop" && setup.setupStep === "sca_deployed") {
      resolvedSlot = "setup_gas_funding";
    } else if (input.kind === "eoa_tx" && setup.setupStep === "gas_funded") {
      const idx = setup.approvalsTxHashes?.length ?? 0;
      if (idx >= 0 && idx < 3) {
        resolvedSlot = (`setup_approve_${idx}` as SetupSlot);
      }
    } else if (
      input.kind === "eip712" &&
      input.purpose === "clob_auth" &&
      setup.setupStep === "approved"
    ) {
      resolvedSlot = "setup_clob_auth";
    }
    if (resolvedSlot) await this.releaseSetupLock(input.userId, resolvedSlot);

    if (input.kind === "userop" && setup.setupStep === "sca_deployed") {
      await this.repo.updateSetupStep(input.userId, "gas_funded");
    } else if (input.kind === "eoa_tx" && setup.setupStep === "gas_funded") {
      const next = [...(setup.approvalsTxHashes ?? []), input.txHash ?? ""];
      await this.repo.setApprovalsTxHashes(input.userId, next);
      if (next.length >= 3) {
        await this.repo.updateSetupStep(input.userId, "approved");
      }
    } else if (
      input.kind === "eip712" &&
      input.purpose === "clob_auth" &&
      setup.setupStep === "approved"
    ) {
      // BE never sees CLOB creds; signature suffices to mark `authed`.
      await this.repo.updateSetupStep(input.userId, "authed");
    } else {
      log.info(
        {
          userId: input.userId,
          step: "setup-notify-no-op",
          setupStep: setup.setupStep,
          kind: input.kind,
        },
        "setup",
      );
      return;
    }
    await this.setupAdvance(input.userId);
  }

  // ── enqueue helpers ──────────────────────────────────────────────────────

  private async enqueueScaToEoa(bet: BetRow, setup: UserSetupRow): Promise<void> {
    const chainId = PREDICTION_MARKETS_ENV.betChainId;
    const usdc = getUsdcAddress(chainId);
    if (!usdc) {
      log.error({ betId: bet.id, chainId, step: "enqueue-sca-to-eoa-no-usdc" }, "place-bet");
      return;
    }
    const stakeRaw = BigInt(bet.stakeUsdcCents) * 10_000n;
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [setup.polygonEoaAddress as `0x${string}`, stakeRaw],
    });
    await this.enqueue(bet, "sca_to_eoa", {
      kind: "userop",
      to: usdc,
      value: "0",
      data,
      description: "Transfer stake from SCA to EOA",
    });
  }

  private async enqueueOrderSign(bet: BetRow, setup: UserSetupRow): Promise<void> {
    if (!bet.outcomeTokenId) {
      log.warn({ betId: bet.id, step: "order-sign-no-token" }, "place-bet");
      await this.repo.setBetFailure(bet.id, "missing-outcome-token");
      return;
    }
    const ob = await this.polymarketAdapter.getOrderbookTopOfBook(bet.outcomeTokenId);
    const liveBps = Math.round(ob.midPrice * BPS_PER_UNIT);
    const refBps = bet.refPriceBps ?? liveBps;
    const driftBps = Math.abs(liveBps - refBps);
    if (driftBps > PREDICTION_MARKETS_ENV.maxOrderDriftBps) {
      log.warn(
        { betId: bet.id, refBps, liveBps, driftBps, step: "order-sign-drift" },
        "place-bet",
      );
      await this.repo.setBetFailure(bet.id, "drift");
      return;
    }

    const slip = PREDICTION_MARKETS_ENV.orderSlippageBps;
    const isClose = bet.betKind === "close";
    // Open: limit above mid (willing to pay up to limit). Close: limit below
    // mid (willing to sell down to limit). Both directions keep slippage in
    // the user's favour.
    const limitBps = isClose ? liveBps - slip : liveBps + slip;
    if (limitBps <= 0 || limitBps >= BPS_PER_UNIT) {
      log.warn({ betId: bet.id, limitBps, isClose, step: "order-sign-bad-limit" }, "place-bet");
      await this.repo.setBetFailure(bet.id, "bad-limit");
      return;
    }

    let makerAmount: string;
    let takerAmount: string;
    if (isClose) {
      // Closing a position: maker pays shares, receives USDC.
      const position = await this.repo.findPositionByClosingBetId(bet.id);
      if (!position) {
        log.warn({ betId: bet.id, step: "order-sign-close-no-position" }, "place-bet");
        await this.repo.setBetFailure(bet.id, "close-position-missing");
        return;
      }
      // sizeShares is a decimal string with up to 6dp; convert to raw (1e6).
      const sharesRawBig = decimalToRaw(position.sizeShares, 6);
      // proceedsRaw = sharesRaw * limitBps / BPS (truncating; we under-quote
      // proceeds so the actual fill never beats the limit in the wrong way).
      const proceedsRawBig = (sharesRawBig * BigInt(limitBps)) / BigInt(BPS_PER_UNIT);
      makerAmount = sharesRawBig.toString();
      takerAmount = proceedsRawBig.toString();
    } else {
      // Opening: maker pays USDC stake, receives shares. Truncating BigInt
      // division round-downs shares so makerAmount/takerAmount ≥ limitPrice.
      const stakeRawBig = BigInt(bet.stakeUsdcCents) * 10_000n;
      const sharesRawBig = (stakeRawBig * BigInt(BPS_PER_UNIT)) / BigInt(limitBps);
      makerAmount = stakeRawBig.toString();
      takerAmount = sharesRawBig.toString();
    }

    const message = buildPolymarketOrderMessage({
      makerEoa: setup.polygonEoaAddress as `0x${string}`,
      tokenId: bet.outcomeTokenId,
      makerAmount,
      takerAmount,
      side: isClose ? "SELL" : "BUY",
      salt: BigInt("0x" + newUuid().replace(/-/g, "")).toString(),
    });

    await this.enqueue(bet, "order_sign", {
      kind: "eip712",
      purpose: "polymarket_order",
      domain: polymarketOrderDomain(PREDICTION_MARKETS_ENV.betChainId),
      types: POLYMARKET_ORDER_TYPES as unknown as Record<
        string,
        Array<{ name: string; type: string }>
      >,
      primaryType: "Order",
      message,
      expectedSigner: setup.polygonEoaAddress,
      description: "Sign Polymarket order",
    });
  }

  private async enqueueResidualSweep(bet: BetRow, setup: UserSetupRow): Promise<void> {
    if (!bet.refundRequired || bet.refundTxHash) return;
    if (!bet.scaToEoaTxHash) {
      await this.repo.setBetRefundRequired(bet.id, false);
      return;
    }
    const chainId = PREDICTION_MARKETS_ENV.betChainId;
    const usdc = getUsdcAddress(chainId);
    if (!usdc) {
      log.error({ betId: bet.id, chainId, step: "sweep-no-usdc" }, "place-bet");
      return;
    }
    // FE clamps the transfer amount to the EOA's actual USDC balance at
    // sign time — we just pre-fill calldata with the stake as an upper bound.
    const stakeRaw = BigInt(bet.stakeUsdcCents) * 10_000n;
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [setup.polygonScaAddress as `0x${string}`, stakeRaw],
    });
    await this.enqueue(bet, "residual_sweep", {
      kind: "eoa_tx",
      to: usdc,
      value: "0",
      data,
      description: "Sweep residual USDC back to SCA",
    });
  }

  private async enqueueSetupGasFunding(setup: UserSetupRow): Promise<void> {
    const chainId = PREDICTION_MARKETS_ENV.betChainId;
    const wei = PREDICTION_MARKETS_ENV.maticBootstrapWei;
    // Userop: SCA sends MATIC to EOA so the EOA can later pay gas for its
    // own approvals + sell orders.
    await this.enqueueSetup(setup.userId, "setup_gas_funding", {
      kind: "userop",
      to: setup.polygonEoaAddress,
      value: wei,
      data: "0x",
      description: "Fund EOA with MATIC for Polymarket approvals",
      chainId,
    });
  }

  private async enqueueSetupApprovals(setup: UserSetupRow): Promise<void> {
    const chainId = PREDICTION_MARKETS_ENV.betChainId;
    const usdc = getUsdcAddress(chainId);
    const cfg = getPolymarketConfig(chainId);
    if (!usdc || !cfg) {
      log.error({ userId: setup.userId, step: "setup-approvals-no-config" }, "setup");
      return;
    }
    // Already-completed approvals are skipped — `setApprovalsTxHashes` is
    // append-only on /response, so the length tells us how many landed.
    const done = (setup.approvalsTxHashes ?? []).length;
    const APPROVE_MAX = (1n << 256n) - 1n;
    const approvals: Array<{ to: string; data: string; description: string }> = [
      {
        to: usdc,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [cfg.ctfExchange, APPROVE_MAX],
        }),
        description: "Approve USDC for Polymarket CTF Exchange",
      },
      {
        to: usdc,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [cfg.negRiskCtfExchange, APPROVE_MAX],
        }),
        description: "Approve USDC for Polymarket NegRisk Exchange",
      },
      {
        to: cfg.conditionalTokens,
        data: encodeFunctionData({
          abi: CTF_SET_APPROVAL_FOR_ALL_ABI,
          functionName: "setApprovalForAll",
          args: [cfg.ctfExchange, true],
        }),
        description: "Authorize CTF Exchange to move outcome tokens",
      },
    ];
    for (let i = done; i < approvals.length; i++) {
      const a = approvals[i];
      await this.enqueueSetup(setup.userId, `setup_approve_${i}` as SetupSlot, {
        kind: "eoa_tx",
        to: a.to,
        value: "0",
        data: a.data,
        description: a.description,
        chainId,
      });
    }
  }

  private async enqueueSetupClobAuth(setup: UserSetupRow): Promise<void> {
    const chainId = PREDICTION_MARKETS_ENV.betChainId;
    const now = newCurrentUTCEpoch();
    await this.enqueueSetup(setup.userId, "setup_clob_auth", {
      kind: "eip712",
      purpose: "clob_auth",
      domain: polymarketClobAuthDomain(chainId),
      types: POLYMARKET_CLOB_AUTH_TYPES as unknown as Record<
        string,
        Array<{ name: string; type: string }>
      >,
      primaryType: "ClobAuth",
      message: {
        address: setup.polygonEoaAddress,
        timestamp: String(now),
        nonce: "0",
        message: POLYMARKET_CLOB_AUTH_MESSAGE,
      },
      expectedSigner: setup.polygonEoaAddress,
      description: "Authorize Polymarket CLOB session",
      chainId,
    });
  }

  private enqueueSetup(
    userId: string,
    slot: SetupSlot,
    payload: EnqueuePayload & { chainId: number },
  ): Promise<void> {
    return this.commitEnqueue({
      userId,
      slot,
      lockKey: setupLockKey(userId, slot),
      chainId: payload.chainId,
      link: { setupForUserId: userId },
      logScope: "setup",
      payload,
    });
  }

  private async releaseSetupLock(userId: string, slot: SetupSlot): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(setupLockKey(userId, slot)).catch(() => undefined);
  }

  // Holds a (betId, slot) NX lock so duplicate advances produce at most one
  // open sign-request — the plan-mandated invariant for safe re-entry from
  // the stuck-bet sweeper and the mini-app re-open path.
  private enqueue(bet: BetRow, slot: EnqueueSlot, payload: EnqueuePayload): Promise<void> {
    return this.commitEnqueue({
      userId: bet.userId,
      slot,
      lockKey: enqueueLockKey(bet.id, slot),
      chainId: PREDICTION_MARKETS_ENV.betChainId,
      link: { betId: bet.id },
      logScope: "place-bet",
      payload,
    });
  }

  // Shared NX-lock + dual-record (signing cache + mini-app cache) write path.
  // Bet- and setup-driven enqueues differ only in the `link` discriminator
  // and the lock-key prefix; everything else is identical.
  private async commitEnqueue(args: {
    userId: string;
    slot: EnqueueSlot | SetupSlot;
    lockKey: string;
    chainId: number;
    link: { betId: string } | { setupForUserId: string };
    logScope: "place-bet" | "setup";
    payload: EnqueuePayload;
  }): Promise<void> {
    const signingRequestUseCase = this.getSigningRequestUseCase?.();
    if (!signingRequestUseCase || !this.miniAppRequestCache || !this.redis) return;
    const acquired = await this.redis.set(args.lockKey, "1", "EX", ENQUEUE_LOCK_TTL_SEC, "NX");
    if (acquired !== "OK") {
      log.debug({ slot: args.slot, step: "enqueue-locked", ...args.link }, args.logScope);
      return;
    }
    const chatId = await this.getChatId(args.userId);
    const now = newCurrentUTCEpoch();
    const requestId = newUuid();
    const p = args.payload;
    const to = p.kind === "eip712" ? "" : p.to;
    const value = p.kind === "eip712" ? "0" : p.value;
    const data = p.kind === "eip712" ? "0x" : p.data;
    const eip712Fields =
      p.kind === "eip712"
        ? {
            purpose: p.purpose,
            domain: p.domain,
            types: p.types,
            primaryType: p.primaryType,
            message: p.message,
          }
        : null;
    const baseRecord: SigningRequestRecord = {
      id: requestId,
      userId: args.userId,
      chatId,
      to,
      value,
      data,
      description: p.description,
      status: "pending",
      createdAt: now,
      expiresAt: now + BET_SIGN_REQUEST_TTL_SEC,
      autoSign: true,
      silentResolution: true,
      ...args.link,
      ...(p.kind === "eip712"
        ? { kind: "eip712" as const, ...eip712Fields!, expectedSigner: p.expectedSigner }
        : { kind: p.kind }),
    };
    const miniAppRequest: SignRequest = {
      requestId,
      requestType: "sign",
      userId: args.userId,
      to,
      value,
      data,
      description: p.description,
      autoSign: true,
      chainId: args.chainId,
      createdAt: now,
      expiresAt: now + BET_SIGN_REQUEST_TTL_SEC,
      primitive: p.kind,
      ...args.link,
      ...(eip712Fields ?? {}),
    };
    try {
      await signingRequestUseCase.create(baseRecord);
      await this.miniAppRequestCache.store(miniAppRequest);
      log.info(
        {
          requestId,
          slot: args.slot,
          kind: args.payload.kind,
          step: `enqueue-${args.slot}`,
          ...args.link,
        },
        args.logScope,
      );
    } catch (err) {
      await this.redis.del(args.lockKey).catch(() => undefined);
      log.error(
        { err, slot: args.slot, step: "enqueue-failed", ...args.link },
        args.logScope,
      );
    }
  }

  private async releaseEnqueueLock(
    betId: string,
    slot: EnqueueSlot,
  ): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(enqueueLockKey(betId, slot)).catch(() => undefined);
  }

  private async getChatId(userId: string): Promise<number> {
    return (await this.chatIdResolver?.(userId)) ?? 0;
  }
}

type EnqueueSlot = "sca_to_eoa" | "order_sign" | "residual_sweep";
type SetupSlot =
  | "setup_gas_funding"
  | "setup_approve_0"
  | "setup_approve_1"
  | "setup_approve_2"
  | "setup_clob_auth";

// Discriminated payload for the shared `commitEnqueue` path. Defined once
// at file scope so bet- and setup-side callers can't drift on shape.
type EnqueuePayload =
  | {
      kind: "userop" | "eoa_tx";
      to: string;
      value: string;
      data: string;
      description: string;
    }
  | {
      kind: "eip712";
      purpose: Eip712Purpose;
      domain: ReturnType<typeof polymarketOrderDomain>;
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
      expectedSigner: string;
      description: string;
    };

function enqueueLockKey(betId: string, slot: EnqueueSlot): string {
  return `pm:bet:enqueue:${betId}:${slot}`;
}

function setupLockKey(userId: string, slot: SetupSlot): string {
  return `pm:setup:enqueue:${userId}:${slot}`;
}

// Minimal ABI snippet for CTF's setApprovalForAll. The CTF deploys at a
// fixed address per chain (see chainConfig.polymarket.conditionalTokens).
const CTF_SET_APPROVAL_FOR_ALL_ABI = [
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

// Decimal-string → raw BigInt at the given fixed decimals. Truncates extras
// (Polymarket shares are nominally 6dp but the DB stores them as plain
// decimal strings; over-precision would silently inflate raw amounts).
function decimalToRaw(decimal: string, decimals: number): bigint {
  const [whole, frac = ""] = decimal.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + fracPadded);
}

function slotForKind(
  kind: SigningRequestKind,
  purpose: Eip712Purpose | undefined,
): EnqueueSlot | null {
  if (kind === "userop") return "sca_to_eoa";
  if (kind === "eoa_tx") return "residual_sweep";
  if (kind === "eip712" && purpose === "polymarket_order") return "order_sign";
  return null;
}
