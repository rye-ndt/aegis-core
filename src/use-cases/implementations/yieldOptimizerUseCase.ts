import type { Address } from "viem";
import type Redis from "ioredis";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { getEnabledYieldChains, getYieldConfig } from "../../helpers/chainConfig";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";
import type { IYieldProtocolRegistry } from "../interface/yield/IYieldProtocolRegistry";
import type { IYieldPoolRanker } from "../interface/yield/IYieldPoolRanker";
import type { IYieldRepository } from "../interface/yield/IYieldRepository";
import type {
  IYieldOptimizerUseCase,
  ScanResult,
  DepositPlan,
  WithdrawPlan,
  DailyReport,
  PositionsView,
  PositionView,
} from "../interface/yield/IYieldOptimizerUseCase";
import { YIELD_PROTOCOL_ID } from "../../helpers/enums/yieldProtocolId.enum";
import type { IChainReader } from "../interface/output/blockchain/chainReader.interface";
import { createLogger } from "../../helpers/observability/logger";

const log = createLogger("yieldOptimizer");

const APY_SERIES_CAP = 84;

const PROTOCOL_DISPLAY_NAMES: Record<YIELD_PROTOCOL_ID, string> = {
  [YIELD_PROTOCOL_ID.AAVE_V3]: "Aave v3",
};

function formatSigned(rawDelta: bigint, decimals: number): string {
  const asNumber = Number(rawDelta) / Math.pow(10, decimals);
  const sign = asNumber >= 0 ? "+" : "";
  return `${sign}${asNumber.toFixed(2)}`;
}

function formatUnsigned(raw: bigint, decimals: number): string {
  const asNumber = Number(raw) / Math.pow(10, decimals);
  return asNumber.toFixed(2);
}

function redisKeyBest(chainId: number, token: string): string {
  return `yield:best:${chainId}:${token.toLowerCase()}`;
}
function redisKeyApySeries(chainId: number, protocolId: string, token: string): string {
  return `yield:apy_series:${chainId}:${protocolId}:${token.toLowerCase()}`;
}
function redisKeyNudgeCooldown(userId: string): string {
  return `yield:nudge_cooldown:${userId}`;
}
function redisKeyNudgePending(userId: string): string {
  return `yield:nudge_pending:${userId}`;
}
function redisKeyReportDone(date: string): string {
  return `yield:report_done:${date}`;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface YieldOptimizerDeps {
  protocolRegistry: IYieldProtocolRegistry;
  ranker: IYieldPoolRanker;
  yieldRepo: IYieldRepository;
  userProfileRepo: IUserProfileDB;
  chainReader: IChainReader;
  redis: Redis;
  nudgeCooldownSec: number;
  idleThresholdUsd: number;
  /** Called by scanIdleForUser to emit the nudge Telegram message */
  sendNudge: (userId: string, chatId: string, apy: number, bestProtocolId: YIELD_PROTOCOL_ID) => Promise<void>;
}

interface BestPool {
  protocolId: YIELD_PROTOCOL_ID;
  score: number;
  apy: number;
  ts: number;
}

export class YieldOptimizerUseCase implements IYieldOptimizerUseCase {
  constructor(private readonly deps: YieldOptimizerDeps) {}

  async runPoolScan(): Promise<void> {
    const chainIds = getEnabledYieldChains();

    for (const chainId of chainIds) {
      const yieldConfig = getYieldConfig(chainId);
      if (!yieldConfig) continue;

      const adapters = this.deps.protocolRegistry.listForChain(chainId);

      for (const stablecoin of yieldConfig.stablecoins) {
        const statuses = [];
        const historyMap: Partial<Record<YIELD_PROTOCOL_ID, number[]>> = {};

        for (const adapter of adapters) {
          try {
            const status = await adapter.getPoolStatus(stablecoin.address);

            const seriesKey = redisKeyApySeries(chainId, adapter.id, stablecoin.address);
            const raw = await this.deps.redis.lrange(seriesKey, 0, -1);
            const existing = raw.map((s) => {
              try {
                return (JSON.parse(s) as { apy: number }).apy;
              } catch {
                return 0;
              }
            });
            historyMap[adapter.id] = existing;

            await this.deps.redis.lpush(
              seriesKey,
              JSON.stringify({ apy: status.supplyApy, ts: status.timestamp }),
            );
            await this.deps.redis.ltrim(seriesKey, 0, APY_SERIES_CAP - 1);

            statuses.push({ protocolId: adapter.id, status });
          } catch (err) {
            log.error({ err, adapterId: adapter.id, chainId }, "adapter getPoolStatus failed");
          }
        }

        if (statuses.length === 0) continue;

        const ranked = this.deps.ranker.rank(statuses, historyMap, stablecoin.decimals);
        const winner = ranked[0];
        if (!winner) {
          log.debug({ choice: "no-winner", chainId, token: stablecoin.address, candidates: statuses.length }, "no ranked winner");
          continue;
        }

        const bestKey = redisKeyBest(chainId, stablecoin.address);
        const bestPayload: BestPool = {
          protocolId: winner.protocolId,
          score: winner.score,
          apy: winner.apy,
          ts: newCurrentUTCEpoch(),
        };
        await this.deps.redis.set(bestKey, JSON.stringify(bestPayload), "EX", 3 * 60 * 60);
        log.info(
          { step: "winner-stored", chainId, token: stablecoin.address, protocolId: winner.protocolId, score: winner.score, apy: winner.apy },
          "best pool stored",
        );
      }
    }
  }

  async scanIdleForUser(userId: string): Promise<ScanResult> {
    const cooldownKey = redisKeyNudgeCooldown(userId);
    if (await this.deps.redis.exists(cooldownKey)) {
      log.debug({ choice: "skip", reason: "cooldown", userId }, "user skipped");
      return { skipped: true, reason: "cooldown" };
    }

    const pendingKey = redisKeyNudgePending(userId);
    if (await this.deps.redis.exists(pendingKey)) {
      log.debug({ choice: "skip", reason: "nudge_pending", userId }, "user skipped");
      return { skipped: true, reason: "nudge_pending" };
    }

    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress || !profile.telegramChatId) {
      log.debug({ choice: "skip", reason: "no_profile", userId }, "user skipped");
      return { skipped: true, reason: "no_profile" };
    }

    const chainIds = getEnabledYieldChains();
    if (chainIds.length === 0) return { skipped: true, reason: "no_chains" };

    const chainId = chainIds[0]!;
    const yieldConfig = getYieldConfig(chainId);
    if (!yieldConfig || yieldConfig.stablecoins.length === 0) {
      return { skipped: true, reason: "no_config" };
    }

    const stablecoin = yieldConfig.stablecoins[0]!;
    const userAddress = profile.smartAccountAddress as Address;

    let balance: bigint;
    try {
      balance = await this.deps.chainReader.getErc20Balance(stablecoin.address, userAddress);
    } catch (err) {
      log.error({ err, userId, chainId, token: stablecoin.address }, "getErc20Balance failed");
      return { skipped: true, reason: "rpc_error" };
    }

    const balanceUsd = Number(balance) / Math.pow(10, stablecoin.decimals);
    if (balanceUsd < this.deps.idleThresholdUsd) {
      log.debug(
        { choice: "skip", reason: "below_threshold", userId, balanceUsd, threshold: this.deps.idleThresholdUsd },
        "user skipped",
      );
      return { skipped: true, reason: "below_threshold" };
    }

    const bestKey = redisKeyBest(chainId, stablecoin.address);
    const bestRaw = await this.deps.redis.get(bestKey);
    if (!bestRaw) {
      log.debug({ choice: "skip", reason: "no_winner", userId, chainId }, "user skipped");
      return { skipped: true, reason: "no_winner" };
    }

    let best: BestPool;
    try {
      best = JSON.parse(bestRaw) as BestPool;
    } catch (err) {
      log.error({ err, userId, bestKey }, "best-pool parse failed");
      return { skipped: true, reason: "parse_error" };
    }

    log.info(
      { step: "user-nudged", userId, chainId, balanceUsd, protocolId: best.protocolId, apy: best.apy },
      "sending idle-balance nudge",
    );
    await this.deps.sendNudge(userId, profile.telegramChatId, best.apy, best.protocolId);

    await this.deps.redis.set(cooldownKey, "1", "EX", this.deps.nudgeCooldownSec);
    await this.deps.redis.set(pendingKey, "1", "EX", 48 * 60 * 60);

    return { skipped: false };
  }

  async buildDepositPlan(userId: string, pct: number): Promise<DepositPlan | null> {
    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress) return null;

    const chainIds = getEnabledYieldChains();
    if (chainIds.length === 0) return null;
    const chainId = chainIds[0]!;

    const yieldConfig = getYieldConfig(chainId);
    if (!yieldConfig || yieldConfig.stablecoins.length === 0) return null;
    const stablecoin = yieldConfig.stablecoins[0]!;

    const userAddress = profile.smartAccountAddress as Address;
    const balance = await this.deps.chainReader.getErc20Balance(stablecoin.address, userAddress);

    const depositAmount = (balance * BigInt(pct)) / 100n;
    if (depositAmount === 0n) return null;

    const bestKey = redisKeyBest(chainId, stablecoin.address);
    const bestRaw = await this.deps.redis.get(bestKey);
    if (!bestRaw) return null;

    const best = JSON.parse(bestRaw) as BestPool;
    const adapter = this.deps.protocolRegistry.get(best.protocolId, chainId);
    if (!adapter) return null;

    const txSteps = await adapter.buildDepositTx({
      user: userAddress,
      token: stablecoin.address,
      amountRaw: depositAmount,
    });

    const depositId = await this.deps.yieldRepo.recordDeposit({
      userId,
      chainId,
      protocolId: best.protocolId,
      tokenAddress: stablecoin.address,
      amountRaw: depositAmount.toString(),
      requestedPct: pct,
      idleAtRequestRaw: balance.toString(),
    });

    await this.deps.redis.del(redisKeyNudgePending(userId));

    return {
      depositId,
      txSteps,
      protocolId: best.protocolId,
      tokenAddress: stablecoin.address,
      amountRaw: depositAmount.toString(),
      chainId,
      userAddress,
    };
  }

  async finalizeDeposit(userId: string, depositId: string, txHash: string): Promise<void> {
    await this.deps.yieldRepo.updateDepositStatus(depositId, "confirmed", txHash);

    const positions = await this.deps.yieldRepo.listActiveProtocols(userId);
    for (const pos of positions) {
      const adapter = this.deps.protocolRegistry.get(
        pos.protocolId as YIELD_PROTOCOL_ID,
        pos.chainId,
      );
      if (!adapter) continue;

      const profile = await this.deps.userProfileRepo.findByUserId(userId);
      if (!profile?.smartAccountAddress) continue;

      const position = await adapter.getUserPosition(
        profile.smartAccountAddress as Address,
        pos.tokenAddress as Address,
      );
      if (!position) continue;

      const principalRaw = await this.deps.yieldRepo.getPrincipalRaw(
        userId,
        pos.chainId,
        pos.protocolId,
        pos.tokenAddress,
      );

      await this.deps.yieldRepo.upsertSnapshot({
        userId,
        chainId: pos.chainId,
        protocolId: pos.protocolId,
        tokenAddress: pos.tokenAddress,
        snapshotDateUtc: todayUtc(),
        balanceRaw: position.balanceRaw.toString(),
        principalRaw,
        snapshotAtEpoch: newCurrentUTCEpoch(),
      });
    }
  }

  async buildWithdrawAllPlan(userId: string): Promise<WithdrawPlan | null> {
    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress) return null;
    const userAddress = profile.smartAccountAddress as Address;

    const positions = await this.deps.yieldRepo.listActiveProtocols(userId);
    if (positions.length === 0) return null;

    const allSteps = [];
    const withdrawals: WithdrawPlan["withdrawals"] = [];

    for (const pos of positions) {
      const adapter = this.deps.protocolRegistry.get(
        pos.protocolId as YIELD_PROTOCOL_ID,
        pos.chainId,
      );
      if (!adapter) continue;

      const position = await adapter.getUserPosition(
        userAddress,
        pos.tokenAddress as Address,
      );
      if (!position || position.balanceRaw === 0n) continue;

      const steps = await adapter.buildWithdrawAllTx({
        user: userAddress,
        token: pos.tokenAddress as Address,
      });
      allSteps.push(...steps);
      withdrawals.push({
        protocolId: pos.protocolId as YIELD_PROTOCOL_ID,
        tokenAddress: pos.tokenAddress,
        chainId: pos.chainId,
        balanceRaw: position.balanceRaw.toString(),
      });
    }

    if (allSteps.length === 0) return null;

    return { txSteps: allSteps, withdrawals, userAddress };
  }

  async finalizeWithdrawal(
    userId: string,
    withdrawals: Array<{
      chainId: number;
      protocolId: YIELD_PROTOCOL_ID;
      tokenAddress: string;
      amountRaw: string;
    }>,
  ): Promise<void> {
    for (const w of withdrawals) {
      await this.deps.yieldRepo.recordWithdrawal({
        userId,
        chainId: w.chainId,
        protocolId: w.protocolId,
        tokenAddress: w.tokenAddress,
        amountRaw: w.amountRaw,
      });
    }
  }

  async getPositions(userId: string): Promise<PositionsView> {
    const emptyTotals = {
      principalHuman: "0.00",
      currentValueHuman: "0.00",
      pnlHuman: "+0.00",
    };

    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress) {
      return { positions: [], totals: emptyTotals };
    }
    const userAddress = profile.smartAccountAddress as Address;

    const activeProtocols = await this.deps.yieldRepo.listActiveProtocols(userId);
    if (activeProtocols.length === 0) {
      return { positions: [], totals: emptyTotals };
    }

    const yesterday = yesterdayUtc();
    const yesterdayEpoch = Math.floor(new Date(`${yesterday}T00:00:00Z`).getTime() / 1000);
    const snapshots = await this.deps.yieldRepo.listSnapshots(userId, yesterdayEpoch - 1);

    const views: PositionView[] = [];
    let totalPrincipalRaw = 0n;
    let totalCurrentRaw = 0n;
    // Assume a single stablecoin (USDC, 6 decimals) — matches current multi-stablecoin
    // scope. If multi-stablecoin lands, totals need per-symbol grouping or USD-normalisation.
    let totalsDecimals = 6;

    for (const pos of activeProtocols) {
      const adapter = this.deps.protocolRegistry.get(
        pos.protocolId as YIELD_PROTOCOL_ID,
        pos.chainId,
      );
      if (!adapter) continue;

      const yieldCfg = getYieldConfig(pos.chainId);
      const stable = yieldCfg?.stablecoins.find(
        (s) => s.address.toLowerCase() === pos.tokenAddress.toLowerCase(),
      );
      if (!stable) continue;
      totalsDecimals = stable.decimals;

      let balanceRaw = 0n;
      try {
        const position = await adapter.getUserPosition(userAddress, pos.tokenAddress as Address);
        balanceRaw = position?.balanceRaw ?? 0n;
      } catch (err) {
        log.error({ err, protocolId: pos.protocolId }, "getUserPosition failed");
        continue;
      }

      const principalStr = await this.deps.yieldRepo.getPrincipalRaw(
        userId,
        pos.chainId,
        pos.protocolId,
        pos.tokenAddress,
      );
      const principalRaw = BigInt(principalStr);

      const yesterdaySnapshot = snapshots.find(
        (s) =>
          s.protocolId === pos.protocolId &&
          s.chainId === pos.chainId &&
          s.tokenAddress === pos.tokenAddress &&
          s.snapshotDateUtc === yesterday,
      );
      // Skip fully-exited positions: deposit rows stay "confirmed" after /withdraw,
      // so listActiveProtocols keeps returning them with balance=0, principal=0.
      if (balanceRaw === 0n && principalRaw === 0n) continue;

      const prevBalance = yesterdaySnapshot ? BigInt(yesterdaySnapshot.balanceRaw) : balanceRaw;
      const delta24h = balanceRaw - prevBalance;
      const lifetimePnl = balanceRaw - principalRaw;

      let apy = 0;
      try {
        const status = await adapter.getPoolStatus(pos.tokenAddress as Address);
        apy = status.supplyApy;
      } catch (err) {
        log.error({ err, protocolId: pos.protocolId }, "getPoolStatus failed");
      }

      totalPrincipalRaw += principalRaw;
      totalCurrentRaw += balanceRaw;

      views.push({
        protocolId: pos.protocolId as YIELD_PROTOCOL_ID,
        protocolName:
          PROTOCOL_DISPLAY_NAMES[pos.protocolId as YIELD_PROTOCOL_ID] ?? pos.protocolId,
        chainId: pos.chainId,
        tokenSymbol: stable.symbol,
        principalHuman: formatUnsigned(principalRaw, stable.decimals),
        currentValueHuman: formatUnsigned(balanceRaw, stable.decimals),
        pnlHuman: formatSigned(lifetimePnl, stable.decimals),
        pnl24hHuman: formatSigned(delta24h, stable.decimals),
        apy,
      });
    }

    return {
      positions: views,
      totals: {
        principalHuman: formatUnsigned(totalPrincipalRaw, totalsDecimals),
        currentValueHuman: formatUnsigned(totalCurrentRaw, totalsDecimals),
        pnlHuman: formatSigned(totalCurrentRaw - totalPrincipalRaw, totalsDecimals),
      },
    };
  }

  reportDoneRedisKey(dateUtc: string): string {
    return redisKeyReportDone(dateUtc);
  }

  async buildDailyReport(userId: string): Promise<DailyReport | null> {
    const positions = await this.deps.yieldRepo.listActiveProtocols(userId);
    if (positions.length === 0) return null;

    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress) return null;
    const userAddress = profile.smartAccountAddress as Address;

    const yesterday = yesterdayUtc();
    const yesterdayEpoch = Math.floor(new Date(`${yesterday}T00:00:00Z`).getTime() / 1000);
    const snapshots = await this.deps.yieldRepo.listSnapshots(userId, yesterdayEpoch - 1);

    const reportPositions: DailyReport["positions"] = [];

    for (const pos of positions) {
      const adapter = this.deps.protocolRegistry.get(
        pos.protocolId as YIELD_PROTOCOL_ID,
        pos.chainId,
      );
      if (!adapter) continue;

      const position = await adapter.getUserPosition(userAddress, pos.tokenAddress as Address);
      if (!position) continue;

      const currentBalance = position.balanceRaw;

      const yesterdaySnapshot = snapshots.find(
        (s) =>
          s.protocolId === pos.protocolId &&
          s.chainId === pos.chainId &&
          s.tokenAddress === pos.tokenAddress &&
          s.snapshotDateUtc === yesterday,
      );

      const prevBalance = yesterdaySnapshot ? BigInt(yesterdaySnapshot.balanceRaw) : 0n;
      const delta24h = currentBalance - prevBalance;

      const principalRaw = await this.deps.yieldRepo.getPrincipalRaw(
        userId,
        pos.chainId,
        pos.protocolId,
        pos.tokenAddress,
      );
      const lifetimePnl = currentBalance - BigInt(principalRaw);

      reportPositions.push({
        protocolId: pos.protocolId as YIELD_PROTOCOL_ID,
        tokenAddress: pos.tokenAddress,
        chainId: pos.chainId,
        balanceRaw: currentBalance.toString(),
        principalRaw,
        delta24hRaw: delta24h.toString(),
        lifetimePnlRaw: lifetimePnl.toString(),
      });

      await this.deps.yieldRepo.upsertSnapshot({
        userId,
        chainId: pos.chainId,
        protocolId: pos.protocolId,
        tokenAddress: pos.tokenAddress,
        snapshotDateUtc: todayUtc(),
        balanceRaw: currentBalance.toString(),
        principalRaw,
        snapshotAtEpoch: newCurrentUTCEpoch(),
      });
    }

    if (reportPositions.length === 0) return null;
    return { userId, positions: reportPositions };
  }
}
