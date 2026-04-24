import type { ITokenRecord } from "./repository/tokenRegistry.repo";

export interface ITokenRegistryService {
  resolve(symbol: string, chainId: number): Promise<{ address: string; decimals: number } | undefined>;
  findByAddressAndChain(address: string, chainId: number): Promise<ITokenRecord | undefined>;
  searchBySymbol(pattern: string, chainId: number): Promise<ITokenRecord[]>;
  listByChain(chainId: number): Promise<ITokenRecord[]>;
}
