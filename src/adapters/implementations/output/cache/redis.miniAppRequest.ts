import type Redis from 'ioredis';
import type { IMiniAppRequestCache } from '../../../../use-cases/interface/output/cache/miniAppRequest.cache';
import type { MiniAppRequest } from '../../../../use-cases/interface/output/cache/miniAppRequest.types';

const REQUEST_TTL_SECONDS = 600;

export class RedisMiniAppRequestCache implements IMiniAppRequestCache {
  constructor(private readonly redis: Redis) {}

  private key(requestId: string): string {
    return `mini_app_req:${requestId}`;
  }

  private userSignQueueKey(userId: string): string {
    return `user_pending_signs:${userId}`;
  }

  async store(request: MiniAppRequest): Promise<void> {
    await this.redis.set(this.key(request.requestId), JSON.stringify(request), 'EX', REQUEST_TTL_SECONDS);
    if (request.requestType === 'sign') {
      await this.redis.zadd(
        this.userSignQueueKey(request.userId),
        request.createdAt,
        request.requestId,
      );
      await this.redis.expire(this.userSignQueueKey(request.userId), REQUEST_TTL_SECONDS);
    }
  }

  async retrieve(requestId: string): Promise<MiniAppRequest | null> {
    const raw = await this.redis.get(this.key(requestId));
    return raw ? (JSON.parse(raw) as MiniAppRequest) : null;
  }

  async delete(requestId: string): Promise<void> {
    const existing = await this.retrieve(requestId);
    await this.redis.del(this.key(requestId));
    if (existing && existing.requestType === 'sign') {
      await this.redis.zrem(this.userSignQueueKey(existing.userId), requestId);
    }
  }

  async findNextPendingSignForUser(userId: string): Promise<MiniAppRequest | null> {
    const ids = await this.redis.zrange(this.userSignQueueKey(userId), 0, -1);
    for (const id of ids) {
      const record = await this.retrieve(id);
      if (record && record.requestType === 'sign') return record;
      // Stale queue entry (TTL expired or already deleted) — clean up.
      await this.redis.zrem(this.userSignQueueKey(userId), id);
    }
    return null;
  }
}
