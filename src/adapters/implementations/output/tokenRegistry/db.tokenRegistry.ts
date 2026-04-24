import type { ITokenRegistryService } from "../../../../use-cases/interface/output/tokenRegistry.interface";
import type { ITokenRecord, ITokenRegistryDB } from "../../../../use-cases/interface/output/repository/tokenRegistry.repo";

export class DbTokenRegistryService implements ITokenRegistryService {
  constructor(private readonly tokenRegistryDB: ITokenRegistryDB) {}

  async resolve(symbol: string, chainId: number): Promise<{ address: string; decimals: number } | undefined> {
    const record = await this.tokenRegistryDB.findBySymbolAndChain(symbol.toUpperCase(), chainId);
    if (!record) return undefined;
    return { address: record.address, decimals: record.decimals };
  }

  async findByAddressAndChain(address: string, chainId: number): Promise<ITokenRecord | undefined> {
    return this.tokenRegistryDB.findByAddressAndChain(address, chainId);
  }

  async searchBySymbol(pattern: string, chainId: number): Promise<ITokenRecord[]> {
    return this.tokenRegistryDB.searchBySymbol(pattern, chainId);
  }

  async listByChain(chainId: number): Promise<ITokenRecord[]> {
    return this.tokenRegistryDB.listByChain(chainId);
  }
}
