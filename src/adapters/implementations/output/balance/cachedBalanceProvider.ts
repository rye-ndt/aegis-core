import { createLogger } from "../../../../helpers/observability/logger";
import type { IBalanceProvider, ProviderBalance } from "../../../../use-cases/interface/output/blockchain/balanceProvider.interface";

const log = createLogger("CachedBalanceProvider");

type CacheEntry = { balances: ProviderBalance[]; expiresAt: number };

export class CachedBalanceProvider implements IBalanceProvider {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly inner: IBalanceProvider,
    private readonly ttlMs: number,
  ) {}

  async getBalances(chainId: number, address: `0x${string}`): Promise<ProviderBalance[]> {
    const key = `${chainId}:${address.toLowerCase()}`;
    const now = Date.now();
    const entry = this.cache.get(key);

    if (entry && entry.expiresAt > now) {
      log.debug({ choice: "hit", chainId }, "balance-cache");
      return entry.balances;
    }

    log.debug({ choice: "miss", chainId }, "balance-cache");
    const balances = await this.inner.getBalances(chainId, address);
    this.cache.set(key, { balances, expiresAt: now + this.ttlMs });
    return balances;
  }
}
