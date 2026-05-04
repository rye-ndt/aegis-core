import type { TxStep } from "./IYieldProtocolAdapter";
import type { YIELD_PROTOCOL_ID } from "../../../helpers/enums/yieldProtocolId.enum";

export interface ScanResult {
  skipped: boolean;
  reason?: string;
}

export interface DepositPlan {
  txSteps: TxStep[];
  protocolId: YIELD_PROTOCOL_ID;
  tokenAddress: string;
  amountRaw: string;
  chainId: number;
  userAddress: string;
}

export interface WithdrawPlan {
  txSteps: TxStep[];
  withdrawals: Array<{
    protocolId: YIELD_PROTOCOL_ID;
    tokenAddress: string;
    chainId: number;
    balanceRaw: string;
  }>;
  userAddress: string;
}

export interface DailyReport {
  userId: string;
  positions: Array<{
    protocolId: YIELD_PROTOCOL_ID;
    tokenAddress: string;
    chainId: number;
    balanceRaw: string;
    principalRaw: string;
    delta24hRaw: string;
    lifetimePnlRaw: string;
  }>;
}

export interface PositionView {
  protocolId: YIELD_PROTOCOL_ID;
  protocolName: string;
  chainId: number;
  tokenSymbol: string;
  principalHuman: string;
  currentValueHuman: string;
  pnlHuman: string;
  pnl24hHuman: string;
  apy: number;
}

export interface PositionsView {
  positions: PositionView[];
  totals: {
    principalHuman: string;
    currentValueHuman: string;
    pnlHuman: string;
  };
}

export interface RebalancePlan {
  txSteps: TxStep[];
  chainId: number;
  tokenAddress: string;
  fromProtocol: YIELD_PROTOCOL_ID;
  toProtocol: YIELD_PROTOCOL_ID;
  /** Position size at plan-build time, used for spend bookkeeping on the supply leg. */
  amountRaw: string;
  /** APY of the source protocol at plan-build time (decimal, e.g. 0.041). */
  fromApy: number;
  /** APY of the destination protocol at plan-build time. */
  toApy: number;
  userAddress: string;
}

export interface IYieldOptimizerUseCase {
  runPoolScan(): Promise<void>;
  scanIdleForUser(userId: string): Promise<ScanResult>;
  scanRebalanceForUser(userId: string): Promise<ScanResult>;
  buildDepositPlan(userId: string, pct: number): Promise<DepositPlan | null>;
  finalizeDeposit(userId: string, txHash: string): Promise<void>;
  buildWithdrawAllPlan(userId: string): Promise<WithdrawPlan | null>;
  buildRebalancePlan(
    userId: string,
    params: {
      chainId: number;
      tokenAddress: string;
      fromProtocol: YIELD_PROTOCOL_ID;
      toProtocol: YIELD_PROTOCOL_ID;
    },
  ): Promise<RebalancePlan | null>;
  finalizeRebalance(
    userId: string,
    params: {
      chainId: number;
      tokenAddress: string;
      fromProtocol: YIELD_PROTOCOL_ID;
      toProtocol: YIELD_PROTOCOL_ID;
    },
  ): Promise<void>;
  clearRebalancePending(userId: string): Promise<void>;
  finalizeWithdrawal(
    userId: string,
    withdrawals: Array<{
      chainId: number;
      protocolId: YIELD_PROTOCOL_ID;
      tokenAddress: string;
      amountRaw: string;
    }>,
  ): Promise<void>;
  buildDailyReport(userId: string): Promise<DailyReport | null>;
  getPositions(userId: string): Promise<PositionsView>;
  reportDoneRedisKey(dateUtc: string): string;
}
