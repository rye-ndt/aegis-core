import { createPublicClient, http, fallback, type PublicClient } from "viem";
import { bsc } from "viem/chains";
import { ASTER_ENV } from "../../../../helpers/env/asterEnv";
import { getChainRpcUrls } from "../../../../helpers/chainConfig";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("asterDiamondClient");

/**
 * Single viem PublicClient pinned to BSC, used by all Aster adapters.
 * Constructed once and reused. RPC fan-out via viem's `fallback` transport.
 */
export class AsterDiamondClient {
  readonly publicClient: PublicClient;
  readonly diamondAddress: `0x${string}` = ASTER_ENV.diamondAddressBsc;

  constructor() {
    const baseUrls = getChainRpcUrls(56);
    const urls = ASTER_ENV.bscRpcUrl
      ? [ASTER_ENV.bscRpcUrl, ...baseUrls]
      : baseUrls;
    if (urls.length === 0) {
      throw new Error("no BSC RPC urls configured");
    }
    this.publicClient = createPublicClient({
      chain: bsc,
      transport: fallback(urls.map((u) => http(u))),
    });
    log.debug(
      { urlCount: urls.length, diamondAddress: this.diamondAddress },
      "client built",
    );
  }
}
