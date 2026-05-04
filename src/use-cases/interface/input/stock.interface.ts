import type { StockPosition } from "../output/stocks/stockPositionsProvider.interface";

export interface BuyPlanInput {
  userId: string;
  symbol: string;
  /** Human-readable USD ("100", "100.5"). 1x leverage hardcoded in v0. */
  amountUsd: string;
  isShort?: boolean;
}

export interface ClosePlanInput {
  userId: string;
  tradeHash: `0x${string}`;
}

export interface SetExitsPlanInput {
  userId: string;
  tradeHash: `0x${string}`;
  /** Human-readable USD or undefined to leave unchanged. */
  stopLossUsd?: string;
  takeProfitUsd?: string;
}

export interface StockExecutionStep {
  label: string;
  to: `0x${string}`;
  data: `0x${string}`;
  /** Decimal raw value as string. "0" for non-payable. */
  value: string;
  /** Each step explicitly carries its own chain id (cross-chain plans). */
  chainId: number;
  /**
   * If set on a step, that tx is the spend leg for the home-chain delegation
   * bookkeeping — `signingRequestUseCase.create` will tag tokenAddress +
   * amountRaw so the resolver bumps spent_raw on success.
   */
  spendTokenAddress?: string;
  spendAmountRaw?: string;
}

export interface StockExecutionPlan {
  // "recovery" is an explicit kind so notifyResolved / capability layers
  // can branch without re-deriving from context (fix #2).
  kind: "buy" | "short" | "close" | "set_exits" | "recovery";
  /** Symbol the plan refers to. For "recovery" with no associated symbol, use "". */
  symbol: string;
  steps: StockExecutionStep[];
  /** Markdown body the capability emits as a `chat` artifact before sign. */
  quoteSummary: string;
}

export type PositionResolution =
  | { kind: "none" }
  | { kind: "one"; position: StockPosition }
  | { kind: "many"; positions: StockPosition[] };

export interface IStockUseCase {
  buildOpenPlan(input: BuyPlanInput): Promise<StockExecutionPlan>;
  buildClosePlan(input: ClosePlanInput): Promise<StockExecutionPlan>;
  buildSetExitsPlan(input: SetExitsPlanInput): Promise<StockExecutionPlan>;
  /** Stand-alone return-swap plan for the recovery flow. Null when balance is 0. */
  buildReturnSwapPlan(input: { userId: string }): Promise<StockExecutionPlan | null>;
  listPositions(userId: string): Promise<StockPosition[]>;
  resolvePositionForSymbol(userId: string, symbol: string): Promise<PositionResolution>;
}
