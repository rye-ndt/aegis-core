import { createLogger } from "../../../../helpers/observability/logger";
import { RateLimitedError } from "../../../../helpers/errors/rateLimitedError";
import type { ITransferHistoryCache } from "../../../../use-cases/interface/output/cache/transferHistory.cache";
import type {
  ITransferHistoryProvider,
  TransferHistoryPage,
  TransferHistoryQuery,
} from "../../../../use-cases/interface/output/blockchain/transferHistoryProvider.interface";

const log = createLogger("CachedTransferHistoryProvider");

export type CachedTransferHistoryConfig = {
  pageTtlSecRecent: number;
  pageTtlSecOlder: number;
  staleTtlSec: number;
  perUserRpm: number;
  rpsGlobal: number;
};

const DEFAULT_CFG: CachedTransferHistoryConfig = {
  pageTtlSecRecent: 60,
  pageTtlSecOlder: 300,
  staleTtlSec: 900,
  perUserRpm: 3,
  rpsGlobal: 10,
};

const SECONDS_PER_DAY = 86_400;

function floorToUtcDay(epoch: number): number {
  return Math.floor(epoch / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}
function ceilToUtcDay(epoch: number): number {
  return Math.ceil(epoch / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

/**
 * Day-bucket the timestamp window so the LLM's slightly-different "last week"
 * epochs across turns hash to the same cache slot. Upstream calls still use
 * the precise epochs the caller passed in.
 */
function buildCacheKey(q: TransferHistoryQuery): string {
  const fromBucket = q.fromEpoch == null ? 0 : floorToUtcDay(q.fromEpoch);
  const toBucket = q.toEpoch == null ? 0 : ceilToUtcDay(q.toEpoch);
  return `v1:${q.chainId}:${q.address.toLowerCase()}:${q.direction ?? "all"}:${fromBucket}:${toBucket}:${q.limit}:${q.cursor ?? ""}`;
}

export class CachedTransferHistoryProvider implements ITransferHistoryProvider {
  private readonly cfg: CachedTransferHistoryConfig;

  constructor(
    private readonly inner: ITransferHistoryProvider,
    private readonly cache: ITransferHistoryCache,
    private readonly userId: string,
    cfg?: Partial<CachedTransferHistoryConfig>,
  ) {
    this.cfg = { ...DEFAULT_CFG, ...(cfg ?? {}) };
  }

  async getHistory(q: TransferHistoryQuery): Promise<TransferHistoryPage> {
    const key = buildCacheKey(q);

    const fresh = await this.cache.get(key);
    log.debug({ choice: fresh ? "hit" : "miss" }, "history-cache");
    if (fresh) return fresh;

    if (!(await this.cache.acquireUserSlot(this.userId, this.cfg.perUserRpm))) {
      log.warn({ userId: this.userId }, "history-rate-limited-user");
      throw new RateLimitedError("transfer-history-rate-limited-user", 60);
    }

    if (!(await this.cache.acquireGlobalSlot(this.cfg.rpsGlobal))) {
      const stale = await this.cache.getStale(key);
      log.warn({ stale: !!stale }, "history-rate-limited-global");
      if (stale) return stale;
      throw new RateLimitedError("transfer-history-rate-limited-global", 5);
    }

    const page = await this.inner.getHistory(q);
    const ttl = q.cursor ? this.cfg.pageTtlSecOlder : this.cfg.pageTtlSecRecent;
    await this.cache.setWithStale(key, page, ttl, this.cfg.staleTtlSec);
    return page;
  }
}
