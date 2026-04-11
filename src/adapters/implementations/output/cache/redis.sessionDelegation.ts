import Redis from 'ioredis';
import type {
  ISessionDelegationCache,
  DelegationRecord,
} from '../../../../use-cases/interface/output/cache/sessionDelegation.cache';

export class RedisSessionDelegationCache implements ISessionDelegationCache {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: false });
    this.redis.on('error', (err: Error) => {
      console.error('[Redis] connection error:', err.message);
    });
  }

  private key(address: string): string {
    return `delegation:${address.toLowerCase()}`;
  }

  async save(record: DelegationRecord): Promise<void> {
    await this.redis.set(this.key(record.address), JSON.stringify(record));
  }

  async findByAddress(address: string): Promise<DelegationRecord | null> {
    const raw = await this.redis.get(this.key(address));
    if (!raw) return null;
    return JSON.parse(raw) as DelegationRecord;
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
