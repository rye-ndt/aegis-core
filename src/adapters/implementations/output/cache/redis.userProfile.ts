import type Redis from "ioredis";
import type { IUserProfileCache } from "../../../../use-cases/interface/output/cache/userProfile.cache";
import type { PrivyUserProfile } from "../../../../use-cases/interface/output/privyAuth.interface";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("userProfileCache");

export class RedisUserProfileCache implements IUserProfileCache {
  constructor(private readonly redis: Redis) {}

  private key(userId: string): string {
    return `user_profile:${userId}`;
  }

  async store(userId: string, profile: PrivyUserProfile, ttlSeconds: number): Promise<void> {
    const safeTtl = Math.max(10, ttlSeconds);
    await this.redis.set(this.key(userId), JSON.stringify(profile), "EX", safeTtl);
    log.debug({ choice: "save", userId, ttl: safeTtl }, "user profile cached");
  }

  async get(userId: string): Promise<PrivyUserProfile | null> {
    const raw = await this.redis.get(this.key(userId));
    log.debug({ choice: raw ? "hit" : "miss", userId }, "user profile lookup");
    return raw ? (JSON.parse(raw) as PrivyUserProfile) : null;
  }
}
