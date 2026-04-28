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

export interface IYieldOptimizerUseCase {
  runPoolScan(): Promise<void>;
  scanIdleForUser(userId: string): Promise<ScanResult>;
  buildDepositPlan(userId: string, pct: number): Promise<DepositPlan | null>;
  finalizeDeposit(userId: string, txHash: string): Promise<void>;
  buildWithdrawAllPlan(userId: string): Promise<WithdrawPlan | null>;
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
