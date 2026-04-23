import type Redis from 'ioredis';
import type { IMiniAppRequestCache } from '../../../../use-cases/interface/output/cache/miniAppRequest.cache';
import type { MiniAppRequest } from '../../../../use-cases/interface/output/cache/miniAppRequest.types';

export class RedisMiniAppRequestCache implements IMiniAppRequestCache {
  constructor(private readonly redis: Redis) {}

  private key(requestId: string): string {
    return `mini_app_req:${requestId}`;
  }

  async store(request: MiniAppRequest): Promise<void> {
    await this.redis.set(this.key(request.requestId), JSON.stringify(request), 'EX', 600);
  }

  async retrieve(requestId: string): Promise<MiniAppRequest | null> {
    const raw = await this.redis.get(this.key(requestId));
    return raw ? (JSON.parse(raw) as MiniAppRequest) : null;
  }

  async delete(requestId: string): Promise<void> {
    await this.redis.del(this.key(requestId));
  }
}
