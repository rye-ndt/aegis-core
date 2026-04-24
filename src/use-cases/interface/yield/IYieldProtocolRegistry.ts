import type { YIELD_PROTOCOL_ID } from "../../../helpers/enums/yieldProtocolId.enum";
import type { IYieldProtocolAdapter } from "./IYieldProtocolAdapter";

export interface IYieldProtocolRegistry {
  get(id: YIELD_PROTOCOL_ID, chainId: number): IYieldProtocolAdapter | null;
  listForChain(chainId: number): IYieldProtocolAdapter[];
}
