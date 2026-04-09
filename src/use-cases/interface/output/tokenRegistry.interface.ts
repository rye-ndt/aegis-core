import type { ITokenRecord } from "./repository/tokenRegistry.repo";

export interface ITokenRegistryService {
  resolve(symbol: string, chainId: number): Promise<{ address: string; decimals: number } | undefined>;
  listByChain(chainId: number): Promise<ITokenRecord[]>;
}
