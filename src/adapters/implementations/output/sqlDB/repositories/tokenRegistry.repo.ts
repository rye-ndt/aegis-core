import { and, eq, ilike, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  ITokenRecord,
  ITokenRegistryDB,
  TokenRecordInit,
} from "../../../../../use-cases/interface/output/repository/tokenRegistry.repo";
import { tokenRegistry } from "../schema";

export class DrizzleTokenRegistryRepo implements ITokenRegistryDB {
  constructor(private readonly db: NodePgDatabase) {}

  async upsert(token: TokenRecordInit): Promise<void> {
    await this.db
      .insert(tokenRegistry)
      .values({
        id: token.id,
        symbol: token.symbol,
        name: token.name,
        chainId: token.chainId,
        address: token.address,
        decimals: token.decimals,
        isNative: token.isNative ?? false,
        isVerified: token.isVerified ?? false,
        logoUri: token.logoUri ?? null,
        deployerAddress: token.deployerAddress ?? null,
        createdAtEpoch: token.createdAtEpoch,
        updatedAtEpoch: token.updatedAtEpoch,
      })
      .onConflictDoUpdate({
        target: [tokenRegistry.symbol, tokenRegistry.chainId],
        set: {
          name: token.name,
          address: token.address,
          decimals: token.decimals,
          isNative: token.isNative ?? false,
          isVerified: token.isVerified ?? false,
          logoUri: token.logoUri ?? null,
          deployerAddress: token.deployerAddress ?? null,
          updatedAtEpoch: token.updatedAtEpoch,
        },
      });
  }

  async findBySymbolAndChain(symbol: string, chainId: number): Promise<ITokenRecord | undefined> {
    const rows = await this.db
      .select()
      .from(tokenRegistry)
      .where(and(eq(tokenRegistry.symbol, symbol), eq(tokenRegistry.chainId, chainId)))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toRecord(rows[0]);
  }

  async findByAddressAndChain(address: string, chainId: number): Promise<ITokenRecord | undefined> {
    const rows = await this.db
      .select()
      .from(tokenRegistry)
      .where(
        and(
          eq(tokenRegistry.chainId, chainId),
          eq(sql`lower(${tokenRegistry.address})`, address.toLowerCase()),
        ),
      )
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toRecord(rows[0]);
  }

  async searchBySymbol(pattern: string, chainId: number): Promise<ITokenRecord[]> {
    const rows = await this.db
      .select()
      .from(tokenRegistry)
      .where(
        and(
          eq(tokenRegistry.chainId, chainId),
          or(
            ilike(tokenRegistry.symbol, `%${pattern}%`),
            ilike(tokenRegistry.name, `%${pattern}%`),
          ),
        ),
      );
    return rows.map((r) => this.toRecord(r));
  }

  async listByChain(chainId: number): Promise<ITokenRecord[]> {
    const rows = await this.db
      .select()
      .from(tokenRegistry)
      .where(eq(tokenRegistry.chainId, chainId));
    return rows.map((r) => this.toRecord(r));
  }

  private toRecord(row: typeof tokenRegistry.$inferSelect): ITokenRecord {
    return {
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      chainId: row.chainId,
      address: row.address,
      decimals: row.decimals,
      isNative: row.isNative,
      isVerified: row.isVerified,
      logoUri: row.logoUri,
      deployerAddress: row.deployerAddress,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
