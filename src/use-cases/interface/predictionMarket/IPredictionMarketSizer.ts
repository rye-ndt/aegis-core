import type { VerifiedFinding } from "./PredictionMarketTypes";

export interface PricedLevel {
  /** 0..1 fractional price (probability of YES at this rung of the book). */
  priceFraction: number;
  /** Depth (shares) available at this price level. */
  shares: number;
}

export interface MarketOrderBook {
  yesBids: PricedLevel[];
  yesAsks: PricedLevel[];
  noBids: PricedLevel[];
  noAsks: PricedLevel[];
}

export interface SizerInput {
  finding: VerifiedFinding;
  orderBook: Record<string, MarketOrderBook>;
  budgetUsdc: number;
  feeBps: number;
  gasEstimateUsdc: number;
  reqId: string;
}

export interface SizedTrade {
  marketId: string;
  outcome: "YES" | "NO";
  shares: number;
  avgPriceFraction: number;
}

export type SizerOutcome =
  | {
      kind: "sized";
      trades: SizedTrade[];
      expectedProfitUsdc: number;
      /** Worst-case payoff across resolution branches. ≥0 for pure arbitrage. */
      minPayoffUsdc: number;
    }
  | { kind: "uneconomic"; bestProfitUsdc: number; reason: string };

export interface IPredictionMarketSizer {
  size(input: SizerInput): Promise<SizerOutcome>;
}
