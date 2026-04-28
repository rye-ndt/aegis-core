import type { Address } from "viem";
import { getYieldConfig } from "../../../../helpers/chainConfig";
import { createLogger } from "../../../../helpers/observability/logger";
import type { IYieldProtocolRegistry } from "../../../../use-cases/interface/yield/IYieldProtocolRegistry";
import type {
  DiscoveredPosition,
  IYieldPositionDiscovery,
} from "../../../../use-cases/interface/output/yield/IYieldPositionDiscovery";

const log = createLogger("onChainPositionDiscovery");

export class OnChainPositionDiscovery implements IYieldPositionDiscovery {
  constructor(private readonly deps: { protocolRegistry: IYieldProtocolRegistry }) {}

  async discover(chainId: number, userAddress: Address): Promise<DiscoveredPosition[]> {
    const cfg = getYieldConfig(chainId);
    if (!cfg) return [];

    const candidates = cfg.protocols.flatMap((protocolId) =>
      cfg.stablecoins.map((s) => ({ protocolId, tokenAddress: s.address })),
    );

    const probed = await Promise.all(
      candidates.map(async (c) => {
        const adapter = this.deps.protocolRegistry.get(c.protocolId, chainId);
        if (!adapter) return null;
        try {
          const pos = await adapter.getUserPosition(userAddress, c.tokenAddress);
          if (!pos || pos.balanceRaw === 0n) {
            log.debug({ choice: "miss", protocolId: c.protocolId, chainId }, "probe");
            return null;
          }
          log.debug({ choice: "hit", protocolId: c.protocolId, chainId }, "probe");
          return {
            chainId,
            protocolId: c.protocolId,
            tokenAddress: c.tokenAddress,
            balanceRaw: pos.balanceRaw,
          } satisfies DiscoveredPosition;
        } catch (err) {
          log.warn({ err, protocolId: c.protocolId, chainId }, "probe-failed");
          return null;
        }
      }),
    );

    return probed.filter((x): x is DiscoveredPosition => x !== null);
  }
}
