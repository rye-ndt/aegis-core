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
  RebalancePlan,
  DailyReport,
  PositionsView,
  PositionView,
} from "../interface/yield/IYieldOptimizerUseCase";
import { YIELD_PROTOCOL_ID } from "../../helpers/enums/yieldProtocolId.enum";
import type { IChainReader } from "../interface/output/blockchain/chainReader.interface";
import type { IPrincipalProvider } from "../interface/output/yield/IPrincipalProvider";
import type { IYieldPositionDiscovery } from "../interface/output/yield/IYieldPositionDiscovery";
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
function redisKeyWinnerStreak(chainId: number, token: string): string {
  return `yield:winner_streak:${chainId}:${token.toLowerCase()}`;
}
function redisKeyRebalanceCooldown(userId: string): string {
  return `yield:rebalance_cooldown:${userId}`;
}
function redisKeyRebalancePending(userId: string): string {
  return `yield:rebalance_pending:${userId}`;
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
  /** TTL for the winner-streak Redis key (typically 4× pool scan interval). */
  winnerStreakTtlSec: number;
  /** Sticky-winner threshold: streak must be ≥ this before user nudges fire. */
  rebalanceStickyScans: number;
  /** Minimum APY uplift in basis points required to nudge a rebalance. */
  rebalanceMinDeltaBps: number;
  /** Cooldown between rebalance nudges per user. */
  rebalanceNudgeCooldownSec: number;
  principalProvider: IPrincipalProvider;
  positionDiscovery: IYieldPositionDiscovery;
  /** Called by scanIdleForUser to emit the nudge Telegram message */
  sendNudge: (userId: string, chatId: string, apy: number, bestProtocolId: YIELD_PROTOCOL_ID) => Promise<void>;
  /** Called by scanRebalanceForUser to emit the rebalance nudge to Telegram. */
  sendRebalanceNudge: (
    userId: string,
    chatId: string,
    params: {
      chainId: number;
      tokenAddress: string;
      tokenSymbol: string;
      fromProtocol: YIELD_PROTOCOL_ID;
      toProtocol: YIELD_PROTOCOL_ID;
      currentApy: number;
      newApy: number;
      balanceHuman: string;
    },
  ) => Promise<void>;
}

interface BestPool {
  protocolId: YIELD_PROTOCOL_ID;
  score: number;
  apy: number;
  ts: number;
}

interface WinnerStreak {
  protocolId: YIELD_PROTOCOL_ID;
  apy: number;
  count: number;
  lastTs: number;
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

        // Sticky-winner streak: nudges only fire after the same protocol
        // wins ≥ rebalanceStickyScans consecutive scans, filtering APY noise.
        const streakKey = redisKeyWinnerStreak(chainId, stablecoin.address);
        const prevRaw = await this.deps.redis.get(streakKey);
        let next: WinnerStreak;
        if (prevRaw) {
          try {
            const prev = JSON.parse(prevRaw) as WinnerStreak;
            next =
              prev.protocolId === winner.protocolId
                ? { protocolId: winner.protocolId, apy: winner.apy, count: prev.count + 1, lastTs: bestPayload.ts }
                : { protocolId: winner.protocolId, apy: winner.apy, count: 1, lastTs: bestPayload.ts };
          } catch (err) {
            log.warn({ err, streakKey }, "winner-streak parse failed; resetting");
            next = { protocolId: winner.protocolId, apy: winner.apy, count: 1, lastTs: bestPayload.ts };
          }
        } else {
          next = { protocolId: winner.protocolId, apy: winner.apy, count: 1, lastTs: bestPayload.ts };
        }
        await this.deps.redis.set(streakKey, JSON.stringify(next), "EX", this.deps.winnerStreakTtlSec);
        log.debug(
          { step: "winner-streak", chainId, token: stablecoin.address, protocolId: next.protocolId, count: next.count },
          "winner streak updated",
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
    await this.deps.redis.set(pendingKey, "1", "EX", this.deps.nudgeCooldownSec);

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

    await this.deps.redis.del(redisKeyNudgePending(userId));

    return {
      txSteps,
      protocolId: best.protocolId,
      tokenAddress: stablecoin.address,
      amountRaw: depositAmount.toString(),
      chainId,
      userAddress,
    };
  }

  async finalizeDeposit(userId: string, txHash: string): Promise<void> {
    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress) return;
    const userAddress = profile.smartAccountAddress as Address;

    const chainId = getEnabledYieldChains()[0];
    if (!chainId) return;

    const discovered = await this.deps.positionDiscovery.discover(chainId, userAddress);
    for (const pos of discovered) {
      const principalFromProvider = await this.deps.principalProvider.getPrincipalRaw({
        userAddress,
        chainId,
        protocolId: pos.protocolId,
        tokenAddress: pos.tokenAddress,
      });
      const principalRaw = (principalFromProvider ?? pos.balanceRaw).toString();

      await this.deps.yieldRepo.upsertSnapshot({
        userId,
        chainId: pos.chainId,
        protocolId: pos.protocolId,
        tokenAddress: pos.tokenAddress,
        snapshotDateUtc: todayUtc(),
        balanceRaw: pos.balanceRaw.toString(),
        principalRaw,
        snapshotAtEpoch: newCurrentUTCEpoch(),
      });
    }

    log.info({ step: "finalize-deposit-snapshot-written", userId, txHash }, "deposit snapshot updated");
  }

  async buildWithdrawAllPlan(userId: string): Promise<WithdrawPlan | null> {
    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress) return null;
    const userAddress = profile.smartAccountAddress as Address;

    const chainId = getEnabledYieldChains()[0];
    if (!chainId) return null;

    const positions = await this.deps.positionDiscovery.discover(chainId, userAddress);
    if (positions.length === 0) return null;

    const allSteps = [];
    const withdrawals: WithdrawPlan["withdrawals"] = [];

    for (const pos of positions) {
      const adapter = this.deps.protocolRegistry.get(pos.protocolId, pos.chainId);
      if (!adapter) continue;

      const steps = await adapter.buildWithdrawAllTx({
        user: userAddress,
        token: pos.tokenAddress,
      });
      allSteps.push(...steps);
      withdrawals.push({
        protocolId: pos.protocolId,
        tokenAddress: pos.tokenAddress,
        chainId: pos.chainId,
        balanceRaw: pos.balanceRaw.toString(),
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
    if (withdrawals.length === 0) return;

    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress) return;
    const userAddress = profile.smartAccountAddress as Address;

    // Group by chainId so we discover once per chain — the discovery
    // probes every (protocol, token) on that chain.
    const byChain = new Map<number, typeof withdrawals>();
    for (const w of withdrawals) {
      const arr = byChain.get(w.chainId) ?? [];
      arr.push(w);
      byChain.set(w.chainId, arr);
    }

    for (const [chainId, items] of byChain) {
      try {
        const discovered = await this.deps.positionDiscovery.discover(chainId, userAddress);
        const discoveredKey = (protocolId: string, tokenAddress: string) =>
          `${protocolId}:${tokenAddress.toLowerCase()}`;
        const discoveredMap = new Map(
          discovered.map((d) => [discoveredKey(d.protocolId, d.tokenAddress), d.balanceRaw]),
        );

        for (const w of items) {
          const balanceRaw =
            discoveredMap.get(discoveredKey(w.protocolId, w.tokenAddress)) ?? 0n;

          // Pull a fresh principal so PnL stays accurate post-withdraw.
          const principalFromProvider = await this.deps.principalProvider.getPrincipalRaw({
            userAddress,
            chainId,
            protocolId: w.protocolId,
            tokenAddress: w.tokenAddress as Address,
          });
          const principalRaw = (principalFromProvider ?? balanceRaw).toString();

          await this.deps.yieldRepo.upsertSnapshot({
            userId,
            chainId,
            protocolId: w.protocolId,
            tokenAddress: w.tokenAddress,
            snapshotDateUtc: todayUtc(),
            balanceRaw: balanceRaw.toString(),
            principalRaw,
            snapshotAtEpoch: newCurrentUTCEpoch(),
          });
        }
        log.info(
          { step: "finalize-withdrawal-snapshot-written", userId, chainId, count: items.length },
          "withdrawal snapshot updated",
        );
      } catch (err) {
        // Withdraw already succeeded on-chain — never rethrow.
        log.warn({ err, userId, chainId }, "finalize-withdrawal snapshot failed");
      }
    }
  }

  async scanRebalanceForUser(userId: string): Promise<ScanResult> {
    const cooldownKey = redisKeyRebalanceCooldown(userId);
    if (await this.deps.redis.exists(cooldownKey)) {
      log.debug({ choice: "skip", reason: "rebalance_cooldown", userId }, "rebalance skipped");
      return { skipped: true, reason: "rebalance_cooldown" };
    }

    const pendingKey = redisKeyRebalancePending(userId);
    if (await this.deps.redis.exists(pendingKey)) {
      log.debug({ choice: "skip", reason: "rebalance_pending", userId }, "rebalance skipped");
      return { skipped: true, reason: "rebalance_pending" };
    }

    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress || !profile.telegramChatId) {
      return { skipped: true, reason: "no_profile" };
    }
    const userAddress = profile.smartAccountAddress as Address;

    const chainIds = getEnabledYieldChains();
    if (chainIds.length === 0) return { skipped: true, reason: "no_chains" };

    for (const chainId of chainIds) {
      const yieldConfig = getYieldConfig(chainId);
      if (!yieldConfig) continue;

      for (const stablecoin of yieldConfig.stablecoins) {
        // Sticky-winner gate.
        const streakKey = redisKeyWinnerStreak(chainId, stablecoin.address);
        const streakRaw = await this.deps.redis.get(streakKey);
        if (!streakRaw) {
          log.debug(
            { choice: "skip", reason: "no_streak", userId, chainId, token: stablecoin.address },
            "rebalance skipped",
          );
          continue;
        }
        let streak: WinnerStreak;
        try {
          streak = JSON.parse(streakRaw) as WinnerStreak;
        } catch (err) {
          log.warn({ err, streakKey }, "winner-streak parse failed");
          continue;
        }
        if (streak.count < this.deps.rebalanceStickyScans) {
          log.debug(
            {
              choice: "skip",
              reason: "streak_below_threshold",
              userId,
              chainId,
              count: streak.count,
              required: this.deps.rebalanceStickyScans,
            },
            "rebalance skipped",
          );
          continue;
        }

        // User position discovery — must hold a position somewhere on this token,
        // and must NOT already be in the sticky-winner protocol.
        const positions = await this.deps.positionDiscovery.discover(chainId, userAddress);
        const tokenLc = stablecoin.address.toLowerCase();
        const heldOnToken = positions.filter(
          (p) => p.tokenAddress.toLowerCase() === tokenLc && p.balanceRaw > 0n,
        );
        if (heldOnToken.length === 0) {
          log.debug(
            { choice: "skip", reason: "no_position", userId, chainId, token: stablecoin.address },
            "rebalance skipped",
          );
          continue;
        }
        const alreadyInWinner = heldOnToken.find((p) => p.protocolId === streak.protocolId);
        if (alreadyInWinner) {
          log.debug(
            { choice: "skip", reason: "already_in_winner", userId, chainId, protocolId: streak.protocolId },
            "rebalance skipped",
          );
          continue;
        }

        // Pick the largest non-winner position as the source.
        const source = heldOnToken.reduce((a, b) => (b.balanceRaw > a.balanceRaw ? b : a));

        // Read current APY for source via best-cache only (no extra RPC).
        // We trust the streak record for the winner APY.
        let currentApy = 0;
        const sourceAdapter = this.deps.protocolRegistry.get(source.protocolId, chainId);
        if (sourceAdapter) {
          try {
            currentApy = (await sourceAdapter.getPoolStatus(stablecoin.address)).supplyApy;
          } catch (err) {
            log.warn({ err, userId, protocolId: source.protocolId }, "rebalance current-apy fetch failed");
          }
        }

        const deltaBps = (streak.apy - currentApy) * 10_000;
        if (deltaBps < this.deps.rebalanceMinDeltaBps) {
          log.debug(
            {
              choice: "skip",
              reason: "delta_below_min",
              userId,
              chainId,
              currentApy,
              winnerApy: streak.apy,
              deltaBps,
              minBps: this.deps.rebalanceMinDeltaBps,
            },
            "rebalance skipped",
          );
          continue;
        }

        const balanceHuman = (
          Number(source.balanceRaw) / Math.pow(10, stablecoin.decimals)
        ).toFixed(2);

        log.info(
          {
            step: "rebalance-nudged",
            userId,
            chainId,
            token: stablecoin.address,
            fromProtocol: source.protocolId,
            toProtocol: streak.protocolId,
            currentApy,
            newApy: streak.apy,
          },
          "sending rebalance nudge",
        );
        await this.deps.sendRebalanceNudge(userId, profile.telegramChatId, {
          chainId,
          tokenAddress: stablecoin.address,
          tokenSymbol: stablecoin.symbol,
          fromProtocol: source.protocolId,
          toProtocol: streak.protocolId,
          currentApy,
          newApy: streak.apy,
          balanceHuman,
        });

        // 1h pending lock — auto-clears if user ignores.
        await this.deps.redis.set(pendingKey, "1", "EX", 3600);
        await this.deps.redis.set(
          cooldownKey,
          "1",
          "EX",
          this.deps.rebalanceNudgeCooldownSec,
        );
        return { skipped: false };
      }
    }

    return { skipped: true, reason: "no_candidate" };
  }

  async buildRebalancePlan(
    userId: string,
    params: {
      chainId: number;
      tokenAddress: string;
      fromProtocol: YIELD_PROTOCOL_ID;
      toProtocol: YIELD_PROTOCOL_ID;
    },
  ): Promise<RebalancePlan | null> {
    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress) return null;
    const userAddress = profile.smartAccountAddress as Address;

    // Re-read position — user may have withdrawn between nudge and tap.
    const positions = await this.deps.positionDiscovery.discover(
      params.chainId,
      userAddress,
    );
    const tokenLc = params.tokenAddress.toLowerCase();
    const source = positions.find(
      (p) =>
        p.protocolId === params.fromProtocol &&
        p.tokenAddress.toLowerCase() === tokenLc &&
        p.balanceRaw > 0n,
    );
    if (!source) return null;

    const fromAdapter = this.deps.protocolRegistry.get(params.fromProtocol, params.chainId);
    const toAdapter = this.deps.protocolRegistry.get(params.toProtocol, params.chainId);
    if (!fromAdapter || !toAdapter) return null;

    const withdrawTxs = await fromAdapter.buildWithdrawAllTx({
      user: userAddress,
      token: params.tokenAddress as Address,
    });
    const depositTxs = await toAdapter.buildDepositTx({
      user: userAddress,
      token: params.tokenAddress as Address,
      amountRaw: source.balanceRaw,
    });

    let fromApy = 0;
    let toApy = 0;
    try {
      fromApy = (await fromAdapter.getPoolStatus(params.tokenAddress as Address)).supplyApy;
    } catch (err) {
      log.warn({ err, protocolId: params.fromProtocol }, "rebalance plan: fromApy fetch failed");
    }
    try {
      toApy = (await toAdapter.getPoolStatus(params.tokenAddress as Address)).supplyApy;
    } catch (err) {
      log.warn({ err, protocolId: params.toProtocol }, "rebalance plan: toApy fetch failed");
    }

    return {
      txSteps: [...withdrawTxs, ...depositTxs],
      chainId: params.chainId,
      tokenAddress: params.tokenAddress,
      fromProtocol: params.fromProtocol,
      toProtocol: params.toProtocol,
      amountRaw: source.balanceRaw.toString(),
      fromApy,
      toApy,
      userAddress,
    };
  }

  async finalizeRebalance(
    userId: string,
    params: {
      chainId: number;
      tokenAddress: string;
      fromProtocol: YIELD_PROTOCOL_ID;
      toProtocol: YIELD_PROTOCOL_ID;
    },
  ): Promise<void> {
    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress) {
      await this.deps.redis.del(redisKeyRebalancePending(userId));
      return;
    }
    const userAddress = profile.smartAccountAddress as Address;

    try {
      const discovered = await this.deps.positionDiscovery.discover(
        params.chainId,
        userAddress,
      );
      const tokenLc = params.tokenAddress.toLowerCase();

      // Snapshot the source (likely 0) and destination (new balance).
      const protocolsToSnap = [params.fromProtocol, params.toProtocol];
      for (const protocolId of protocolsToSnap) {
        const found = discovered.find(
          (d) =>
            d.protocolId === protocolId &&
            d.tokenAddress.toLowerCase() === tokenLc,
        );
        const balanceRaw = found ? found.balanceRaw : 0n;

        const principalFromProvider = await this.deps.principalProvider.getPrincipalRaw({
          userAddress,
          chainId: params.chainId,
          protocolId,
          tokenAddress: params.tokenAddress as Address,
        });
        const principalRaw = (principalFromProvider ?? balanceRaw).toString();

        await this.deps.yieldRepo.upsertSnapshot({
          userId,
          chainId: params.chainId,
          protocolId,
          tokenAddress: params.tokenAddress,
          snapshotDateUtc: todayUtc(),
          balanceRaw: balanceRaw.toString(),
          principalRaw,
          snapshotAtEpoch: newCurrentUTCEpoch(),
        });
      }
      log.info(
        { step: "finalize-rebalance-snapshot-written", userId, chainId: params.chainId },
        "rebalance snapshots updated",
      );
    } catch (err) {
      // On-chain rebalance already succeeded — never rethrow.
      log.warn({ err, userId, chainId: params.chainId }, "finalize-rebalance snapshot failed");
    } finally {
      await this.deps.redis.del(redisKeyRebalancePending(userId));
    }
  }

  async clearRebalancePending(userId: string): Promise<void> {
    await this.deps.redis.del(redisKeyRebalancePending(userId));
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

    const chainId = getEnabledYieldChains()[0];
    if (!chainId) return { positions: [], totals: emptyTotals };

    const discovered = await this.deps.positionDiscovery.discover(chainId, userAddress);
    if (discovered.length === 0) return { positions: [], totals: emptyTotals };

    const yesterday = yesterdayUtc();
    const yesterdayStartEpoch = Math.floor(new Date(`${yesterday}T00:00:00Z`).getTime() / 1000);
    const todayStartEpoch = Math.floor(new Date(`${todayUtc()}T00:00:00Z`).getTime() / 1000);
    const snapshots = await this.deps.yieldRepo.listSnapshotsBetween(
      userId,
      yesterdayStartEpoch,
      todayStartEpoch,
    );

    const cfg = getYieldConfig(chainId)!;
    const views: PositionView[] = [];
    let totalPrincipalRaw = 0n;
    let totalCurrentRaw = 0n;
    let totalsDecimals = 6;

    for (const pos of discovered) {
      const stable = cfg.stablecoins.find(
        (s) => s.address.toLowerCase() === pos.tokenAddress.toLowerCase(),
      );
      if (!stable) continue;
      totalsDecimals = stable.decimals;

      const balanceRaw = pos.balanceRaw;

      const principalFromProvider = await this.deps.principalProvider.getPrincipalRaw({
        userAddress,
        chainId,
        protocolId: pos.protocolId,
        tokenAddress: pos.tokenAddress,
      });
      const principalRaw = principalFromProvider ?? balanceRaw;

      const ySnap = snapshots.find(
        (s) =>
          s.protocolId === pos.protocolId &&
          s.tokenAddress === pos.tokenAddress &&
          s.snapshotDateUtc === yesterday,
      );
      if (!ySnap) {
        log.warn(
          { step: "snapshot-missing", userId, protocolId: pos.protocolId, chainId, tokenAddress: pos.tokenAddress },
          "falling-back-to-zero-24h-delta",
        );
      }
      const prevBalance = ySnap ? BigInt(ySnap.balanceRaw) : balanceRaw;

      const adapter = this.deps.protocolRegistry.get(pos.protocolId, chainId);
      let apy = 0;
      if (adapter) {
        try {
          apy = (await adapter.getPoolStatus(pos.tokenAddress)).supplyApy;
        } catch (err) {
          log.error({ err, protocolId: pos.protocolId }, "getPoolStatus failed");
        }
      }

      totalPrincipalRaw += principalRaw;
      totalCurrentRaw += balanceRaw;

      views.push({
        protocolId: pos.protocolId,
        protocolName: PROTOCOL_DISPLAY_NAMES[pos.protocolId] ?? pos.protocolId,
        chainId,
        tokenSymbol: stable.symbol,
        principalHuman: formatUnsigned(principalRaw, stable.decimals),
        currentValueHuman: formatUnsigned(balanceRaw, stable.decimals),
        pnlHuman: formatSigned(balanceRaw - principalRaw, stable.decimals),
        pnl24hHuman: formatSigned(balanceRaw - prevBalance, stable.decimals),
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
    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress) return null;
    const userAddress = profile.smartAccountAddress as Address;

    const chainId = getEnabledYieldChains()[0];
    if (!chainId) return null;

    const positions = await this.deps.positionDiscovery.discover(chainId, userAddress);
    if (positions.length === 0) return null;

    const yesterday = yesterdayUtc();
    const yesterdayStartEpoch = Math.floor(new Date(`${yesterday}T00:00:00Z`).getTime() / 1000);
    const todayStartEpoch = Math.floor(new Date(`${todayUtc()}T00:00:00Z`).getTime() / 1000);
    const snapshots = await this.deps.yieldRepo.listSnapshotsBetween(
      userId,
      yesterdayStartEpoch,
      todayStartEpoch,
    );

    const reportPositions: DailyReport["positions"] = [];

    for (const pos of positions) {
      const currentBalance = pos.balanceRaw;

      const yesterdaySnapshot = snapshots.find(
        (s) =>
          s.protocolId === pos.protocolId &&
          s.chainId === pos.chainId &&
          s.tokenAddress === pos.tokenAddress &&
          s.snapshotDateUtc === yesterday,
      );

      if (!yesterdaySnapshot) {
        log.warn(
          { step: "snapshot-missing", userId, protocolId: pos.protocolId, chainId, tokenAddress: pos.tokenAddress },
          "falling-back-to-zero-24h-delta",
        );
      }

      const prevBalance = yesterdaySnapshot ? BigInt(yesterdaySnapshot.balanceRaw) : currentBalance;
      const delta24h = currentBalance - prevBalance;

      const principalFromProvider = await this.deps.principalProvider.getPrincipalRaw({
        userAddress,
        chainId,
        protocolId: pos.protocolId,
        tokenAddress: pos.tokenAddress,
      });
      const principalRaw = (principalFromProvider ?? currentBalance).toString();
      const lifetimePnl = currentBalance - BigInt(principalRaw);

      reportPositions.push({
        protocolId: pos.protocolId,
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
