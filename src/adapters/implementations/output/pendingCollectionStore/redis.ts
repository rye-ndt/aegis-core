import type Redis from "ioredis";
import type {
  IPendingCollectionStore,
  PendingCollection,
} from "../../../../use-cases/interface/output/pendingCollectionStore.interface";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";

// Hard ceiling so a stale/abandoned Redis row cannot live forever
// even if a capability forgets to call `clear()`. Individual
// pendings still honor their own `expiresAt`.
const MAX_TTL_SECONDS = 60 * 60; // 1 h

export class RedisPendingCollectionStore implements IPendingCollectionStore {
  constructor(private readonly redis: Redis) {}

  private key(channelId: string): string {
    return `pending_collection:${channelId}`;
  }

  async get(channelId: string): Promise<PendingCollection | null> {
    const raw = await this.redis.get(this.key(channelId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingCollection;
    if (parsed.expiresAt <= newCurrentUTCEpoch()) {
      await this.redis.del(this.key(channelId));
      return null;
    }
    return parsed;
  }

  async save(channelId: string, pending: PendingCollection): Promise<void> {
    const now = newCurrentUTCEpoch();
    const ttlFromPending = Math.max(1, pending.expiresAt - now);
    const ttl = Math.min(ttlFromPending, MAX_TTL_SECONDS);
    await this.redis.set(
      this.key(channelId),
      JSON.stringify(pending),
      "EX",
      ttl,
    );
  }

  async clear(channelId: string): Promise<void> {
    await this.redis.del(this.key(channelId));
  }
}
