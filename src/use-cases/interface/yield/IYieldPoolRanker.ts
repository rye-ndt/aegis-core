import type { YIELD_PROTOCOL_ID } from "../../../helpers/enums/yieldProtocolId.enum";
import type { PoolStatus } from "./IYieldProtocolAdapter";

export interface RankedPool {
  protocolId: YIELD_PROTOCOL_ID;
  score: number;
  apy: number;
}

export interface IYieldPoolRanker {
  rank(
    statuses: Array<{ protocolId: YIELD_PROTOCOL_ID; status: PoolStatus }>,
    history: Partial<Record<YIELD_PROTOCOL_ID, number[]>>,
    tokenDecimals: number,
  ): RankedPool[];
}
