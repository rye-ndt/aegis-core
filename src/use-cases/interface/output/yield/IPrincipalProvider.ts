import type { Address } from "viem";
import type { YIELD_PROTOCOL_ID } from "../../../../helpers/enums/yieldProtocolId.enum";

export type PrincipalQuery = {
  userAddress: Address;
  chainId: number;
  protocolId: YIELD_PROTOCOL_ID;
  tokenAddress: Address;
};

export interface IPrincipalProvider {
  /**
   * Cumulative net principal (sum(deposits) - sum(withdrawals)) in raw token units.
   * Returns null when the provider cannot answer authoritatively (network error,
   * subgraph lag) — caller treats null as "unknown" and falls back to balanceRaw (zero PnL).
   */
  getPrincipalRaw(q: PrincipalQuery): Promise<bigint | null>;
}
