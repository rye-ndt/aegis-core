import type Redis from 'ioredis';
import type {
  ISigningRequestCache,
  SigningRequestRecord,
} from '../../../../use-cases/interface/output/cache/signingRequest.cache';

export class RedisSigningRequestCache implements ISigningRequestCache {
  constructor(private readonly redis: Redis) {}

  private key(id: string): string {
    return `sign_req:${id}`;
  }

  private pendingKey(userId: string): string {
    return `sign_req:pending:${userId}`;
  }

  async save(record: SigningRequestRecord): Promise<void> {
    const ttl = Math.max(10, record.expiresAt - Math.floor(Date.now() / 1000));
    const pipeline = this.redis.pipeline();
    pipeline.set(this.key(record.id), JSON.stringify(record), 'EX', ttl);
    pipeline.set(this.pendingKey(record.userId), record.id, 'EX', ttl);
    await pipeline.exec();
  }

  async findById(id: string): Promise<SigningRequestRecord | null> {
    const raw = await this.redis.get(this.key(id));
    return raw ? (JSON.parse(raw) as SigningRequestRecord) : null;
  }

  async resolve(id: string, status: 'approved' | 'rejected', txHash?: string): Promise<void> {
    const record = await this.findById(id);
    if (!record) return;
    const pipeline = this.redis.pipeline();
    pipeline.set(this.key(id), JSON.stringify({ ...record, status, txHash }), 'KEEPTTL');
    // Only delete the pending pointer if it still points at this request.
    // Protects against a newer request overwriting the pointer before this one resolves.
    pipeline.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      this.pendingKey(record.userId),
      id,
    );
    await pipeline.exec();
  }

  async findPendingByUserId(userId: string): Promise<SigningRequestRecord | null> {
    const id = await this.redis.get(this.pendingKey(userId));
    if (!id) return null;
    const record = await this.findById(id);
    if (!record || record.status !== 'pending') return null;
    return record;
  }
}
