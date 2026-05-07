import { aesEncrypt } from "../../helpers/crypto/aesGcm";
import { PREDICTION_MARKETS_ENV } from "../../helpers/env/predictionMarketEnv";
import { deriveScaAddress } from "../../helpers/deriveScaAddress";
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

export class PredictionMarketBetUseCase implements IPredictionMarketBetUseCase {
  constructor(
    private readonly repo: IPredictionMarketBetRepository,
    private readonly userProfileDB: IUserProfileDB,
    private readonly polymarketAdapter: IPolymarketAdapter,
  ) {}

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
    return bet;
  }

  async cancelBetIntent(userId: string, intentId: string): Promise<void> {
    const intent = await this.repo.getBetIntent(intentId);
    if (!intent || intent.userId !== userId) return;
    await this.repo.setBetIntentStatus(intentId, "cancelled");
    log.info({ userId, intentId, step: "cancelled" }, "place-bet");
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
}
