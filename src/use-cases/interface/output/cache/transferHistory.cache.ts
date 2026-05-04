import type { TransferHistoryPage } from "../blockchain/transferHistoryProvider.interface";

export interface ITransferHistoryCache {
  /** Return a fresh cached page, or null on miss / parse error. */
  get(key: string): Promise<TransferHistoryPage | null>;

  /**
   * Return a stale page (older than fresh TTL but not yet expired) — used as a
   * fallback when the global upstream gate refuses a slot. Returns null when
   * neither a fresh nor a stale entry exists.
   */
  getStale(key: string): Promise<TransferHistoryPage | null>;

  /**
   * Store a page as fresh (TTL `ttlSec`) AND as a longer-lived stale companion
   * (TTL `staleTtlSec`). The stale entry survives past the fresh one so the
   * cache can degrade gracefully when upstream is gated.
   */
  setWithStale(
    key: string,
    page: TransferHistoryPage,
    ttlSec: number,
    staleTtlSec: number,
  ): Promise<void>;

  /**
   * Per-user upstream rate guard. Returns true when the caller may issue another
   * upstream call this minute, false when the per-window quota is exhausted.
   */
  acquireUserSlot(userId: string, perUserRpm: number): Promise<boolean>;

  /**
   * Global upstream rate guard. Returns true when there is headroom against the
   * shared Ankr quota, false when the per-second cap is exhausted.
   */
  acquireGlobalSlot(rpsGlobal: number): Promise<boolean>;
}
