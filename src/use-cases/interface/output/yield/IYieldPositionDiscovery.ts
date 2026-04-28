import type { Address } from "viem";
import type { YIELD_PROTOCOL_ID } from "../../../../helpers/enums/yieldProtocolId.enum";

export type DiscoveredPosition = {
  chainId: number;
  protocolId: YIELD_PROTOCOL_ID;
  tokenAddress: Address;
  balanceRaw: bigint;
};

export interface IYieldPositionDiscovery {
  /** Probe every configured (protocol × stablecoin) on `chainId`. Returns only non-zero positions. */
  discover(chainId: number, userAddress: Address): Promise<DiscoveredPosition[]>;
}
