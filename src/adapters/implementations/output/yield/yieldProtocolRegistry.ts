import type { YIELD_PROTOCOL_ID } from "../../../../helpers/enums/yieldProtocolId.enum";
import type { IYieldProtocolAdapter } from "../../../../use-cases/interface/yield/IYieldProtocolAdapter";
import type { IYieldProtocolRegistry } from "../../../../use-cases/interface/yield/IYieldProtocolRegistry";

export class YieldProtocolRegistry implements IYieldProtocolRegistry {
  private readonly adapters: IYieldProtocolAdapter[] = [];

  constructor(adapters: IYieldProtocolAdapter[]) {
    this.adapters = adapters;
  }

  get(id: YIELD_PROTOCOL_ID, chainId: number): IYieldProtocolAdapter | null {
    return (
      this.adapters.find((a) => a.id === id && a.chainId === chainId) ?? null
    );
  }

  listForChain(chainId: number): IYieldProtocolAdapter[] {
    return this.adapters.filter((a) => a.chainId === chainId);
  }
}
