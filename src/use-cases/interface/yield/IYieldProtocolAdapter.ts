import type { Address } from "viem";
import type { YIELD_PROTOCOL_ID } from "../../../helpers/enums/yieldProtocolId.enum";

export interface TxStep {
  to: Address;
  data: `0x${string}`;
  value: bigint;
}

export interface PoolStatus {
  supplyApy: number;
  utilization: number;
  liquidityRaw: bigint;
  timestamp: number;
}

export interface IYieldProtocolAdapter {
  readonly id: YIELD_PROTOCOL_ID;
  readonly chainId: number;

  getPoolStatus(token: Address): Promise<PoolStatus>;

  buildDepositTx(params: {
    user: Address;
    token: Address;
    amountRaw: bigint;
  }): Promise<TxStep[]>;

  buildWithdrawAllTx(params: {
    user: Address;
    token: Address;
  }): Promise<TxStep[]>;

  getUserPosition(user: Address, token: Address): Promise<{ balanceRaw: bigint } | null>;
}
