import { createLogger } from "../../../../helpers/observability/logger";
import type { IBalanceProvider, ProviderBalance } from "../../../../use-cases/interface/output/blockchain/balanceProvider.interface";
import type { ITokenRegistryService } from "../../../../use-cases/interface/output/tokenRegistry.interface";
import type { IChainReader } from "../../../../use-cases/interface/output/blockchain/chainReader.interface";

const log = createLogger("RpcBalanceProvider");

export class RpcBalanceProvider implements IBalanceProvider {
  constructor(
    private readonly chainReader: IChainReader,
    private readonly tokenRegistryService: ITokenRegistryService,
  ) {}

  async getBalances(chainId: number, address: `0x${string}`): Promise<ProviderBalance[]> {
    const start = Date.now();
    log.debug({ chainId, address: `${address.slice(0, 6)}…${address.slice(-4)}` }, "rpc-balance-request");

    const tokens = await this.tokenRegistryService.listByChain(chainId);

    const results = await Promise.all(
      tokens.map(async (token) => {
        const rawBigInt = await (token.isNative
          ? this.chainReader.getNativeBalance(address)
          : this.chainReader.getErc20Balance(token.address as `0x${string}`, address)
        ).catch(() => 0n);

        return {
          symbol: token.symbol,
          address: token.address,
          decimals: token.decimals,
          balance: (Number(rawBigInt) / 10 ** token.decimals).toFixed(6),
          rawBalance: rawBigInt.toString(),
          usdValue: null as number | null,
          isNative: token.isNative ?? false,
          rawBigInt,
        };
      }),
    );

    const nonZero = results
      .filter((b) => b.rawBigInt > 0n)
      .sort((a, b) => (a.rawBigInt > b.rawBigInt ? -1 : a.rawBigInt < b.rawBigInt ? 1 : 0))
      .map(({ rawBigInt: _raw, ...rest }) => rest);

    log.info({ chainId, count: nonZero.length, durationMs: Date.now() - start }, "rpc-balances-fetched");
    return nonZero;
  }
}
