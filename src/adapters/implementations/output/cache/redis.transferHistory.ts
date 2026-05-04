import type Redis from "ioredis";
import { createLogger } from "../../../../helpers/observability/logger";
import type { ITransferHistoryCache } from "../../../../use-cases/interface/output/cache/transferHistory.cache";
import type { TransferHistoryPage } from "../../../../use-cases/interface/output/blockchain/transferHistoryProvider.interface";

const log = createLogger("redisTransferHistoryCache");

export class RedisTransferHistoryCache implements ITransferHistoryCache {
  constructor(private readonly redis: Redis) {}

  private freshKey(key: string): string {
    return `txhist:${key}`;
  }
  private staleKey(key: string): string {
    return `txhist:stale:${key}`;
  }
  private userRlKey(userId: string, minute: number): string {
    return `txhist:rl:user:${userId}:${minute}`;
  }
  private globalRlKey(second: number): string {
    return `txhist:rl:global:${second}`;
  }

  async get(key: string): Promise<TransferHistoryPage | null> {
    try {
      const raw = await this.redis.get(this.freshKey(key));
      log.debug({ choice: raw ? "hit" : "miss" }, "history-cache-fresh");
      return raw ? (JSON.parse(raw) as TransferHistoryPage) : null;
    } catch (err) {
      log.error({ err }, "history-cache-get-failed");
      return null;
    }
  }

  async getStale(key: string): Promise<TransferHistoryPage | null> {
    try {
      const raw = await this.redis.get(this.staleKey(key));
      log.debug({ choice: raw ? "hit" : "miss" }, "history-cache-stale");
      return raw ? (JSON.parse(raw) as TransferHistoryPage) : null;
    } catch (err) {
      log.error({ err }, "history-cache-stale-failed");
      return null;
    }
  }

  async setWithStale(
    key: string,
    page: TransferHistoryPage,
    ttlSec: number,
    staleTtlSec: number,
  ): Promise<void> {
    try {
      const json = JSON.stringify(page);
      await Promise.all([
        this.redis.set(this.freshKey(key), json, "EX", Math.max(1, ttlSec)),
        this.redis.set(this.staleKey(key), json, "EX", Math.max(1, staleTtlSec)),
      ]);
      log.debug({ ttlSec, staleTtlSec }, "history-cache-write");
    } catch (err) {
      log.error({ err }, "history-cache-set-failed");
    }
  }

  async acquireUserSlot(userId: string, perUserRpm: number): Promise<boolean> {
    if (perUserRpm <= 0) return true;
    try {
      const minute = Math.floor(Date.now() / 60_000);
      const key = this.userRlKey(userId, minute);
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, 70);
      }
      const ok = count <= perUserRpm;
      log.debug({ userId, count, perUserRpm, ok }, "history-rl-user");
      return ok;
    } catch (err) {
      log.error({ err }, "history-rl-user-failed");
      return true;
    }
  }

  async acquireGlobalSlot(rpsGlobal: number): Promise<boolean> {
    if (rpsGlobal <= 0) return true;
    try {
      const second = Math.floor(Date.now() / 1_000);
      const key = this.globalRlKey(second);
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, 2);
      }
      const ok = count <= rpsGlobal;
      log.debug({ count, rpsGlobal, ok }, "history-rl-global");
      return ok;
    } catch (err) {
      log.error({ err }, "history-rl-global-failed");
      return true;
    }
  }
}
