import type { ITokenRegistryService } from "../../../../use-cases/interface/output/tokenRegistry.interface";
import type { ITokenRecord, ITokenRegistryDB } from "../../../../use-cases/interface/output/repository/tokenRegistry.repo";
import {
  getNativeTokenInfo,
  isNativeAddress,
  isNativeSymbolForChain,
} from "../../../../helpers/chainConfig";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("dbTokenRegistryService");

/**
 * Synthesises an in-memory ITokenRecord for the chain's native token.
 * Native tokens are NOT stored in the DB — they're derived from
 * `chainConfig.getNativeTokenInfo(chainId)` which combines viem's
 * `Chain.nativeCurrency` with our registry's `nativeSymbol`. This avoids
 * indexer collisions on the (symbol, chainId) upsert key and keeps native
 * support automatic for any newly-registered chain.
 */
function buildNativeRecord(chainId: number): ITokenRecord | undefined {
  const info = getNativeTokenInfo(chainId);
  if (!info) return undefined;
  return {
    id: `native-${chainId}`,
    symbol: info.symbol,
    name: info.name,
    chainId,
    address: info.address,
    decimals: info.decimals,
    isNative: true,
    isVerified: true,
    logoUri: null,
    deployerAddress: null,
    createdAtEpoch: 0,
    updatedAtEpoch: 0,
  };
}

export class DbTokenRegistryService implements ITokenRegistryService {
  constructor(private readonly tokenRegistryDB: ITokenRegistryDB) {}

  async resolve(symbol: string, chainId: number): Promise<{ address: string; decimals: number } | undefined> {
    if (isNativeSymbolForChain(symbol, chainId)) {
      const native = buildNativeRecord(chainId)!;
      log.debug({ chainId, symbol, choice: "native-synth" }, "resolve hit native");
      return { address: native.address, decimals: native.decimals };
    }
    const record = await this.tokenRegistryDB.findBySymbolAndChain(symbol.toUpperCase(), chainId);
    if (!record) return undefined;
    return { address: record.address, decimals: record.decimals };
  }

  async findByAddressAndChain(address: string, chainId: number): Promise<ITokenRecord | undefined> {
    if (isNativeAddress(address)) {
      log.debug({ chainId, address, choice: "native-synth" }, "findByAddress hit native");
      return buildNativeRecord(chainId);
    }
    return this.tokenRegistryDB.findByAddressAndChain(address, chainId);
  }

  async searchBySymbol(pattern: string, chainId: number): Promise<ITokenRecord[]> {
    const dbRows = await this.tokenRegistryDB.searchBySymbol(pattern, chainId);
    const native = buildNativeRecord(chainId);
    if (!native) return dbRows;
    const needle = pattern.trim().toLowerCase();
    const matchesNative =
      native.symbol.toLowerCase().includes(needle) ||
      native.name.toLowerCase().includes(needle);
    if (!matchesNative) return dbRows;
    // Exact symbol match on native: short-circuit to a single resolved
    // candidate so the user is never asked to disambiguate "AVAX" against
    // a list of *AVAX-suffixed ERC-20s.
    if (needle === native.symbol.toLowerCase()) {
      log.debug({ chainId, pattern, choice: "native-exact" }, "searchBySymbol exact native match");
      return [native];
    }
    // Substring match: prepend native (deduped against any DB row that
    // may still carry the pseudo-address from legacy seeds).
    const filtered = dbRows.filter((r) => !isNativeAddress(r.address));
    return [native, ...filtered];
  }

  async listByChain(chainId: number): Promise<ITokenRecord[]> {
    const dbRows = await this.tokenRegistryDB.listByChain(chainId);
    const native = buildNativeRecord(chainId);
    if (!native) return dbRows;
    const filtered = dbRows.filter((r) => !isNativeAddress(r.address));
    return [native, ...filtered];
  }
}
