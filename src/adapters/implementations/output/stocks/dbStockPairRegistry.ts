import type { IStockPairRegistry } from "../../../../use-cases/interface/output/stocks/stockPair.interface";
import type {
  IStockPairDB,
  IStockPairRecord,
} from "../../../../use-cases/interface/output/repository/stockPair.repo";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("dbStockPairRegistry");

/**
 * DB-backed stock pair registry. Keeps an in-memory snapshot of all pairs for
 * the venue chain so the existing sync read API (`resolve`, `symbols`,
 * `list`) doesn't have to change. The crawler job refreshes the snapshot
 * after every tick.
 *
 * `resolveByQuery` adds natural-language resolution: tries exact symbol
 * match, then exact name-word match, then substring match. The capability's
 * deterministic parser uses this to translate "apple" → "AAPL" without an
 * LLM call. Rows whose `name` equals their `symbol` (i.e. SEC EDGAR had no
 * friendly name — typically Aster's forex/crypto pairs) are skipped during
 * name-based matching so a query like "tether" can't accidentally hit
 * "USDT" if Aster ever lists it.
 */
export class DbStockPairRegistry implements IStockPairRegistry {
  private snapshot: IStockPairRecord[] = [];

  constructor(
    private readonly stockPairDB: IStockPairDB,
    private readonly chainId: number,
  ) {}

  async refresh(): Promise<void> {
    try {
      const rows = await this.stockPairDB.listByChain(this.chainId);
      this.snapshot = rows.filter((r) => r.isActive);
      log.info(
        { count: this.snapshot.length, chainId: this.chainId },
        "snapshot refreshed",
      );
    } catch (err) {
      log.error({ err, chainId: this.chainId }, "snapshot refresh failed");
    }
  }

  resolve(symbol: string): `0x${string}` | null {
    const upper = symbol.trim().toUpperCase();
    const hit = this.snapshot.find((r) => r.symbol === upper);
    return hit ? (hit.pairBase as `0x${string}`) : null;
  }

  resolveByQuery(
    query: string,
  ): { symbol: string; pairBase: `0x${string}` } | null {
    const cleaned = query.trim();
    if (!cleaned) return null;
    const lower = cleaned.toLowerCase();
    if (this.snapshot.length === 0) {
      log.warn(
        { query: cleaned, snapshotSize: 0 },
        "resolveByQuery on empty snapshot — registry not hydrated",
      );
      return null;
    }

    // 1. Exact symbol match (case-insensitive). Highest precedence.
    const symbolHit = this.snapshot.find(
      (r) => r.symbol.toLowerCase() === lower,
    );
    if (symbolHit) {
      return {
        symbol: symbolHit.symbol,
        pairBase: symbolHit.pairBase as `0x${string}`,
      };
    }

    // Only consider rows whose name was successfully enriched (i.e. SEC
    // EDGAR provided a real company name distinct from the symbol).
    const enriched = this.snapshot.filter(
      (r) => r.name.toLowerCase() !== r.symbol.toLowerCase(),
    );

    // 2. First-word-of-name exact match. "apple" → "Apple Inc.".
    const firstWordHit = enriched.find((r) => {
      const firstWord = r.name.toLowerCase().split(/\s+/)[0] ?? "";
      // Strip trailing punctuation like "Apple," → "apple".
      return firstWord.replace(/[^a-z0-9]/g, "") === lower;
    });
    if (firstWordHit) {
      return {
        symbol: firstWordHit.symbol,
        pairBase: firstWordHit.pairBase as `0x${string}`,
      };
    }

    // 3. Whole-word-of-name match anywhere ("alphabet" → "Alphabet Inc.").
    const wordHit = enriched.find((r) =>
      r.name
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/[^a-z0-9]/g, ""))
        .includes(lower),
    );
    if (wordHit) {
      return {
        symbol: wordHit.symbol,
        pairBase: wordHit.pairBase as `0x${string}`,
      };
    }

    return null;
  }

  symbols(): readonly string[] {
    return this.snapshot.map((r) => r.symbol);
  }

  list(): ReadonlyArray<{ symbol: string; pairBase: `0x${string}` }> {
    return this.snapshot.map((r) => ({
      symbol: r.symbol,
      pairBase: r.pairBase as `0x${string}`,
    }));
  }
}
