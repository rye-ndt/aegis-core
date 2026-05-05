import type Redis from "ioredis";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  IPendingIntentStore,
  PendingIntent,
} from "../../../../use-cases/interface/output/cache/pendingIntent.cache";

const log = createLogger("redisPendingIntent");
const MAX_TTL_SECONDS = 60 * 60;

export class RedisPendingIntentStore implements IPendingIntentStore {
  constructor(private readonly redis: Redis) {}

  private key(approvalRequestId: string): string {
    return `pending_intent:${approvalRequestId}`;
  }

  async get(approvalRequestId: string): Promise<PendingIntent | null> {
    const raw = await this.redis.get(this.key(approvalRequestId));
    if (!raw) {
      log.debug({ choice: "miss", approvalRequestId }, "lookup");
      return null;
    }
    const parsed = JSON.parse(raw) as PendingIntent;
    if (parsed.expiresAt <= newCurrentUTCEpoch()) {
      await this.redis.del(this.key(approvalRequestId));
      log.debug({ choice: "expired", approvalRequestId }, "lookup");
      return null;
    }
    log.debug({ choice: "hit", approvalRequestId, capabilityId: parsed.capabilityId }, "lookup");
    return parsed;
  }

  async save(pending: PendingIntent): Promise<void> {
    const now = newCurrentUTCEpoch();
    const ttlFromPending = Math.max(1, pending.expiresAt - now);
    const ttl = Math.min(ttlFromPending, MAX_TTL_SECONDS);
    await this.redis.set(
      this.key(pending.approvalRequestId),
      JSON.stringify(pending),
      "EX",
      ttl,
    );
    log.debug(
      { approvalRequestId: pending.approvalRequestId, capabilityId: pending.capabilityId, ttl },
      "saved",
    );
  }

  async delete(approvalRequestId: string): Promise<void> {
    await this.redis.del(this.key(approvalRequestId));
  }
}
