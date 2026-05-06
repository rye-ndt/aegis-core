import type Redis from 'ioredis';
import type {
  ISigningRequestCache,
  SigningRequestRecord,
} from '../../../../use-cases/interface/output/cache/signingRequest.cache';
import { newCurrentUTCEpoch } from '../../../../helpers/time/dateTime';
import { createLogger } from '../../../../helpers/observability/logger';

const log = createLogger('signingRequestCache');

// Per-user index TTL. Bound to the same 10-minute window as a signing
// request's max lifetime — stale members in the set safely point at keys
// that have already TTL-expired in Redis, and `cancelPendingForUser` skips
// any entry whose record is gone.
const USER_INDEX_TTL_SEC = 10 * 60;

export class RedisSigningRequestCache implements ISigningRequestCache {
  constructor(private readonly redis: Redis) {}

  private key(id: string): string {
    return `sign_req:${id}`;
  }

  private userKey(userId: string): string {
    return `sign_req:user:${userId}`;
  }

  /**
   * Schema notes for `SigningRequestRecord` round-trips:
   * - The record is JSON-serialised; new optional fields (e.g. `preview`
   *   added in the result-card framework P2 migration) are forward- and
   *   backward-compatible automatically — old records read by new code see
   *   `preview: undefined`, new records read by old code ignore it.
   * - DO NOT bump the `sign_req:` prefix on schema additions — it would
   *   strand in-flight pending requests at deploy time. Reserve a version
   *   bump for a *breaking* shape change (renaming an existing field,
   *   removing one, or changing a value's type).
   */
  async save(record: SigningRequestRecord): Promise<void> {
    const ttl = Math.max(10, record.expiresAt - newCurrentUTCEpoch());
    const multi = this.redis.multi();
    multi.set(this.key(record.id), JSON.stringify(record), 'EX', ttl);
    // Maintain the per-user index only for `pending` records — resolved /
    // expired records have no business being cancelled. Refresh the set's
    // TTL on every add so it covers the longest-living member.
    if (record.status === 'pending') {
      multi.sadd(this.userKey(record.userId), record.id);
      multi.expire(this.userKey(record.userId), USER_INDEX_TTL_SEC);
    }
    await multi.exec();
    log.debug({ choice: 'save', id: record.id, ttl }, 'signing request cached');
  }

  async findById(id: string): Promise<SigningRequestRecord | null> {
    const raw = await this.redis.get(this.key(id));
    log.debug({ choice: raw ? 'hit' : 'miss', id }, 'signing request lookup');
    return raw ? (JSON.parse(raw) as SigningRequestRecord) : null;
  }

  async resolve(
    id: string,
    status: 'approved' | 'rejected',
    txHash?: string,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    const record = await this.findById(id);
    if (!record) return;
    const next: SigningRequestRecord = {
      ...record,
      status,
      txHash,
      errorCode,
      errorMessage,
    };
    const multi = this.redis.multi();
    multi.set(this.key(id), JSON.stringify(next), 'KEEPTTL');
    // Drop from the user index — the record is now terminal and must not
    // appear in a future `cancelPendingForUser` sweep.
    multi.srem(this.userKey(record.userId), id);
    await multi.exec();
  }

  async cancelPendingForUser(userId: string): Promise<string[]> {
    const ids = await this.redis.smembers(this.userKey(userId));
    if (ids.length === 0) return [];

    const cancelled: string[] = [];
    // Walk one-by-one rather than pipelining: we only flip records that are
    // *still* pending, so each iteration is a read-modify-write the caller
    // wants per-record correctness on. Volume here is bounded (a single user's
    // outstanding signing requests, typically 0–2) so the round-trip cost is
    // negligible.
    for (const id of ids) {
      const raw = await this.redis.get(this.key(id));
      if (!raw) continue;
      const record = JSON.parse(raw) as SigningRequestRecord;
      if (record.status !== 'pending') continue;
      const next: SigningRequestRecord = { ...record, status: 'expired' };
      await this.redis.set(this.key(id), JSON.stringify(next), 'KEEPTTL');
      cancelled.push(id);
    }
    // Whether or not entries were flipped, the index is no longer interesting
    // — every member is either now expired (we just flipped it), already
    // terminal, or stale. Clear it so the next sweep starts clean.
    await this.redis.del(this.userKey(userId));

    if (cancelled.length > 0) {
      log.info(
        { step: 'pending-superseded', userId, count: cancelled.length },
        'signing requests flipped to expired by supersession',
      );
    }
    return cancelled;
  }
}
