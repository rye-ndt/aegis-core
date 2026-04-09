export interface ITokenRecord {
  id: string;
  symbol: string;
  name: string;
  chainId: number;
  address: string;
  decimals: number;
  isNative: boolean;
  isVerified: boolean;
  logoUri?: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface TokenRecordInit {
  id: string;
  symbol: string;
  name: string;
  chainId: number;
  address: string;
  decimals: number;
  isNative?: boolean;
  isVerified?: boolean;
  logoUri?: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface ITokenRegistryDB {
  upsert(token: TokenRecordInit): Promise<void>;
  findBySymbolAndChain(symbol: string, chainId: number): Promise<ITokenRecord | undefined>;
  listByChain(chainId: number): Promise<ITokenRecord[]>;
}
