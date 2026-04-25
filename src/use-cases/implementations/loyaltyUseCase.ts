import type Redis from "ioredis";
import { LOYALTY_STATUSES } from "../../helpers/enums/loyaltyStatuses.enum";
import { computePointsV1 } from "../../helpers/loyalty/pointsFormula";
import { metricsRegistry } from "../../helpers/observability/metricsRegistry";
import { createLogger } from "../../helpers/observability/logger";
import type {
  ILoyaltyRepository,
  LedgerEntry,
  LoyaltySeason,
} from "../interface/output/repository/loyalty.repo";
import type {
  AdjustInput,
  AwardPointsInput,
  BalanceView,
  ILoyaltyUseCase,
  LeaderboardView,
} from "../interface/input/loyalty.interface";

const log = createLogger("loyaltyUseCase");

const FORMULA_VERSION = "v1";
const SEASON_CACHE_KEY = "loyalty:season:active";
const LEADERBOARD_CACHE_PREFIX = "loyalty:leaderboard:";
const PG_UNIQUE_VIOLATION = "23505";

function todayStartUtcEpoch(): number {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.floor(midnight.getTime() / 1000);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === PG_UNIQUE_VIOLATION;
}

export interface LoyaltyUseCaseDeps {
  repo: ILoyaltyRepository;
  redis?: Redis;
  activeSeasonCacheTtlMs: number;
  leaderboardCacheTtlMs: number;
}

export class LoyaltyUseCaseImpl implements ILoyaltyUseCase {
  constructor(private readonly deps: LoyaltyUseCaseDeps) {}

  async awardPoints(input: AwardPointsInput): Promise<LedgerEntry | null> {
    const start = Date.now();
    try {
      const loyaltyStatus = await this.deps.repo.getUserLoyaltyStatus(input.userId);
      if (loyaltyStatus === LOYALTY_STATUSES.FORBIDDEN) {
        metricsRegistry.recordLoyaltyAward(input.actionType, "forbidden");
        return null;
      }

      if (input.intentExecutionId) {
        const existing = await this.deps.repo.findByIntentExecutionId(input.intentExecutionId);
        if (existing) {
          metricsRegistry.recordLoyaltyAward(input.actionType, "duplicate");
          return existing;
        }
      }

      const season = await this.getActiveSeason();
      if (!season) {
        log.info({ step: "no_active_season", userId: input.userId, actionType: input.actionType }, "no active season");
        metricsRegistry.recordLoyaltyAward(input.actionType, "no_season");
        return null;
      }

      const actionType = await this.deps.repo.getActionType(input.actionType);
      if (!actionType || !actionType.isActive) {
        metricsRegistry.recordLoyaltyAward(input.actionType, "inactive_action");
        return null;
      }

      const { points, breakdown } = computePointsV1(
        { actionType: input.actionType, usdValue: input.usdValue, userMultiplier: input.userMultiplier },
        season.config,
        { defaultBase: actionType.defaultBase },
      );

      if (points === 0n) {
        log.info(
          { step: "skipped_min_usd", userId: input.userId, actionType: input.actionType, usdValue: input.usdValue },
          "below minimum usd threshold",
        );
        metricsRegistry.recordLoyaltyAward(input.actionType, "below_min_usd");
        return null;
      }

      let finalPoints = points;
      if (season.config.dailyUserCap !== null) {
        const todayStart = todayStartUtcEpoch();
        const todaySum = await this.deps.repo.getSumPointsToday(input.userId, season.id, todayStart);
        const remaining = BigInt(season.config.dailyUserCap) - todaySum;
        if (remaining <= 0n) {
          log.info(
            { step: "daily_cap_hit", userId: input.userId, actionType: input.actionType },
            "daily user cap reached",
          );
          metricsRegistry.recordLoyaltyAward(input.actionType, "daily_cap");
          return null;
        }
        if (points > remaining) {
          finalPoints = remaining;
          log.info(
            { step: "capped", userId: input.userId, actionType: input.actionType, raw: points.toString(), capped: finalPoints.toString() },
            "points clamped to daily cap",
          );
        }
      }

      let entry: LedgerEntry;
      try {
        entry = await this.deps.repo.insertLedgerEntry({
          userId: input.userId,
          seasonId: season.id,
          actionType: input.actionType,
          pointsRaw: finalPoints,
          intentExecutionId: input.intentExecutionId ?? null,
          externalRef: input.externalRef ?? null,
          formulaVersion: FORMULA_VERSION,
          computedFromJson: { ...breakdown, usdValue: input.usdValue, userMultiplier: input.userMultiplier },
          metadataJson: input.metadataJson ?? null,
        });
      } catch (err) {
        if (isUniqueViolation(err) && input.intentExecutionId) {
          const existing = await this.deps.repo.findByIntentExecutionId(input.intentExecutionId);
          if (existing) {
            metricsRegistry.recordLoyaltyAward(input.actionType, "duplicate");
            return existing;
          }
        }
        throw err;
      }

      const durationMs = Date.now() - start;
      log.info(
        { step: "awarded", userId: input.userId, actionType: input.actionType, points: finalPoints.toString(), intentExecutionId: input.intentExecutionId },
        "points awarded",
      );
      metricsRegistry.recordLoyaltyAward(input.actionType, "awarded", finalPoints, durationMs);
      return entry;
    } catch (err) {
      log.error({ err, userId: input.userId, actionType: input.actionType, intentExecutionId: input.intentExecutionId }, "award failed");
      metricsRegistry.recordLoyaltyAward(input.actionType, "error");
      return null;
    }
  }

  async getActiveSeasonId(): Promise<string | null> {
    const season = await this.getActiveSeason();
    return season?.id ?? null;
  }

  async getBalance(userId: string, seasonId?: string): Promise<BalanceView> {
    const season = seasonId ? { id: seasonId } : await this.getActiveSeason();
    if (!season) {
      return { seasonId: seasonId ?? "none", pointsTotal: 0n, rank: null };
    }

    const loyaltyStatus = await this.deps.repo.getUserLoyaltyStatus(userId);
    if (loyaltyStatus === LOYALTY_STATUSES.FLAGGED || loyaltyStatus === LOYALTY_STATUSES.FORBIDDEN) {
      return { seasonId: season.id, pointsTotal: 0n, rank: null };
    }

    const [pointsTotal, rank] = await Promise.all([
      this.deps.repo.getUserBalance(userId, season.id),
      this.deps.repo.getUserRank(userId, season.id),
    ]);

    return { seasonId: season.id, pointsTotal, rank };
  }

  async getHistory(userId: string, opts: { seasonId?: string; limit: number; cursorCreatedAtEpoch?: number }): Promise<LedgerEntry[]> {
    const season = opts.seasonId ? { id: opts.seasonId } : await this.getActiveSeason();
    if (!season) return [];
    return this.deps.repo.getHistory(userId, season.id, opts.limit, opts.cursorCreatedAtEpoch);
  }

  async getLeaderboard(seasonId: string, limit: number): Promise<LeaderboardView> {
    const cacheKey = `${LEADERBOARD_CACHE_PREFIX}${seasonId}:${limit}`;
    if (this.deps.redis) {
      const cached = await this.deps.redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { userId: string; pointsTotal: string; rank: number }[];
        return {
          entries: parsed.map((e) => ({ ...e, pointsTotal: BigInt(e.pointsTotal) })),
          seasonId,
        };
      }
    }

    const entries = await this.deps.repo.getLeaderboard(seasonId, limit);

    if (this.deps.redis) {
      const serialized = JSON.stringify(entries.map((e) => ({ ...e, pointsTotal: e.pointsTotal.toString() })));
      await this.deps.redis.set(cacheKey, serialized, "PX", this.deps.leaderboardCacheTtlMs);
    }

    return { entries, seasonId };
  }

  async adjustPoints(input: AdjustInput): Promise<LedgerEntry> {
    return this.deps.repo.insertLedgerEntry({
      userId: input.userId,
      seasonId: input.seasonId,
      actionType: input.actionType,
      pointsRaw: input.pointsRaw,
      intentExecutionId: null,
      externalRef: input.externalRef ?? null,
      formulaVersion: FORMULA_VERSION,
      computedFromJson: { manual: true },
      metadataJson: input.metadataJson ?? null,
    });
  }

  private async getActiveSeason(): Promise<LoyaltySeason | null> {
    if (this.deps.redis) {
      const cached = await this.deps.redis.get(SEASON_CACHE_KEY);
      if (cached) {
        log.debug({ choice: "season-cache-hit" }, "active season from cache");
        return JSON.parse(cached) as LoyaltySeason;
      }
      log.debug({ choice: "season-cache-miss" }, "active season cache miss");
    }

    const season = await this.deps.repo.getActiveSeason();
    if (!season) return null;

    if (this.deps.redis) {
      await this.deps.redis.set(SEASON_CACHE_KEY, JSON.stringify(season), "PX", this.deps.activeSeasonCacheTtlMs);
    }

    return season;
  }
}
