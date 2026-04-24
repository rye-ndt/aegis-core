import type Redis from 'ioredis';
import type {
  ISigningRequestCache,
  SigningRequestRecord,
} from '../../../../use-cases/interface/output/cache/signingRequest.cache';
import { newCurrentUTCEpoch } from '../../../../helpers/time/dateTime';
import { createLogger } from '../../../../helpers/observability/logger';

const log = createLogger('signingRequestCache');

export class RedisSigningRequestCache implements ISigningRequestCache {
  constructor(private readonly redis: Redis) {}

  private key(id: string): string {
    return `sign_req:${id}`;
  }

  async save(record: SigningRequestRecord): Promise<void> {
    const ttl = Math.max(10, record.expiresAt - newCurrentUTCEpoch());
    await this.redis.set(this.key(record.id), JSON.stringify(record), 'EX', ttl);
    log.debug({ choice: 'save', id: record.id, ttl }, 'signing request cached');
  }

  async findById(id: string): Promise<SigningRequestRecord | null> {
    const raw = await this.redis.get(this.key(id));
    log.debug({ choice: raw ? 'hit' : 'miss', id }, 'signing request lookup');
    return raw ? (JSON.parse(raw) as SigningRequestRecord) : null;
  }

  async resolve(id: string, status: 'approved' | 'rejected', txHash?: string): Promise<void> {
    const record = await this.findById(id);
    if (!record) return;
    await this.redis.set(this.key(id), JSON.stringify({ ...record, status, txHash }), 'KEEPTTL');
  }
}
