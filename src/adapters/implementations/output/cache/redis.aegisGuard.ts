import type Redis from "ioredis";
import type { IAegisGuardCache, AegisGuardGrant } from "../../../../use-cases/interface/output/cache/aegisGuard.cache";

export class RedisAegisGuardCache implements IAegisGuardCache {
  constructor(private readonly redis: Redis) {}

  async saveGrant(userId: string, grant: AegisGuardGrant, ttlSeconds: number): Promise<void> {
    const key = `aegis_guard:grant:${userId}`;
    await this.redis.set(key, JSON.stringify(grant), "EX", ttlSeconds);
  }

  async getGrant(userId: string): Promise<AegisGuardGrant | null> {
    const key = `aegis_guard:grant:${userId}`;
    const data = await this.redis.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as AegisGuardGrant;
    } catch {
      return null;
    }
  }

  async addSpent(userId: string, tokenAddress: string, amountWei: string, ttlSeconds: number): Promise<string> {
    const key = `aegis_guard:spent:${userId}:${tokenAddress.toLowerCase()}`;
    
    // We execute a WATCH -> GET -> SET logic locally in node to properly handle unbounded BigInt addition
    // since Redis INCRBY maxes out at 64-bit signed integers which is only ~9 ETH for 18 decimals.
    
    // Maximum retries for optimistic concurrency
    const MAX_RETRIES = 5;
    for (let i = 0; i < MAX_RETRIES; i++) {
      await this.redis.watch(key);
      const currentRaw = await this.redis.get(key);
      const current = currentRaw ? BigInt(currentRaw) : 0n;
      const next = current + BigInt(amountWei);
      
      const multi = this.redis.multi();
      multi.set(key, next.toString(), "EX", ttlSeconds);
      
      const res = await multi.exec();
      if (res !== null) {
        // successfully updated
        return next.toString();
      }
      // If res is null, watch failed, retry
    }
    
    throw new Error("Failed to add spent due to high concurrency");
  }

  async getSpent(userId: string, tokenAddress: string): Promise<string> {
    const key = `aegis_guard:spent:${userId}:${tokenAddress.toLowerCase()}`;
    const data = await this.redis.get(key);
    return data ?? "0";
  }
}
