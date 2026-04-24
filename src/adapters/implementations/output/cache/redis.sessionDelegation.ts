import type Redis from 'ioredis';
import type {
  ISessionDelegationCache,
  DelegationRecord,
} from '../../../../use-cases/interface/output/cache/sessionDelegation.cache';
import { createLogger } from '../../../../helpers/observability/logger';

const log = createLogger('sessionDelegationCache');

export class RedisSessionDelegationCache implements ISessionDelegationCache {
  constructor(private readonly redis: Redis) {}

  private key(address: string): string {
    return `delegation:${address.toLowerCase()}`;
  }

  async save(record: DelegationRecord): Promise<void> {
    await this.redis.set(this.key(record.address), JSON.stringify(record));
    log.debug({ choice: 'save', address: record.address }, 'delegation cached');
  }

  async findByAddress(address: string): Promise<DelegationRecord | null> {
    const raw = await this.redis.get(this.key(address));
    log.debug({ choice: raw ? 'hit' : 'miss', address }, 'delegation lookup');
    if (!raw) return null;
    return JSON.parse(raw) as DelegationRecord;
  }

}
