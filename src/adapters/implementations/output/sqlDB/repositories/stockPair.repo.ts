import { and, eq, ilike, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IStockPairDB,
  IStockPairRecord,
  StockPairChainFields,
} from "../../../../../use-cases/interface/output/repository/stockPair.repo";
import { stockPairs } from "../schema";

export class DrizzleStockPairRepo implements IStockPairDB {
  constructor(private readonly db: NodePgDatabase) {}

  async upsertChainFields(row: StockPairChainFields): Promise<void> {
    await this.db
      .insert(stockPairs)
      .values({
        id: row.id,
        symbol: row.symbol,
        // Placeholder on first insert — SEC-EDGAR pass overwrites later.
        // On conflict, the existing name is preserved (see set clause below).
        name: row.symbol,
        chainId: row.chainId,
        pairBase: row.pairBase,
        isActive: row.isActive,
        createdAtEpoch: row.createdAtEpoch,
        updatedAtEpoch: row.updatedAtEpoch,
      })
      .onConflictDoUpdate({
        target: [stockPairs.symbol, stockPairs.chainId],
        set: {
          pairBase: row.pairBase,
          isActive: row.isActive,
          updatedAtEpoch: row.updatedAtEpoch,
        },
      });
  }

  async setName(symbol: string, chainId: number, name: string): Promise<void> {
    await this.db
      .update(stockPairs)
      .set({ name, updatedAtEpoch: Math.floor(Date.now() / 1000) })
      .where(and(eq(stockPairs.symbol, symbol), eq(stockPairs.chainId, chainId)));
  }

  async findBySymbolAndChain(
    symbol: string,
    chainId: number,
  ): Promise<IStockPairRecord | undefined> {
    const rows = await this.db
      .select()
      .from(stockPairs)
      .where(and(eq(stockPairs.symbol, symbol), eq(stockPairs.chainId, chainId)))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toRecord(rows[0]);
  }

  async searchByNameOrSymbol(
    query: string,
    chainId: number,
  ): Promise<IStockPairRecord[]> {
    const rows = await this.db
      .select()
      .from(stockPairs)
      .where(
        and(
          eq(stockPairs.chainId, chainId),
          eq(stockPairs.isActive, true),
          or(
            ilike(stockPairs.symbol, `%${query}%`),
            ilike(stockPairs.name, `%${query}%`),
          ),
        ),
      );
    return rows.map((r) => this.toRecord(r));
  }

  async listByChain(chainId: number): Promise<IStockPairRecord[]> {
    const rows = await this.db
      .select()
      .from(stockPairs)
      .where(eq(stockPairs.chainId, chainId));
    return rows.map((r) => this.toRecord(r));
  }

  private toRecord(row: typeof stockPairs.$inferSelect): IStockPairRecord {
    return {
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      chainId: row.chainId,
      pairBase: row.pairBase,
      isActive: row.isActive,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
