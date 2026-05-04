/**
 * Output port — read open stock positions for a trader.
 *
 * Phase 2 ships scaffolding only. The `getPositionsV2` ABI struct is not
 * verified against published Aster source (Aster's contracts are not
 * open-sourced), so the adapter's `mapRawPosition` throws by default. Once
 * the verified struct lands, replace `mapRawPosition` and remove the throw.
 *
 * Phase 3 (close / SL / TP) is the first user-visible flow that exercises
 * this port — so a regression here does not affect the Phase 2 buy/short
 * happy path.
 */
export interface StockPosition {
  tradeHash: `0x${string}`;
  symbol: string;
  side: "long" | "short";
  /** Human-readable USD with 2 fractional digits (e.g. "189.42"). */
  entryPriceUsd: string;
  markPriceUsd: string;
  collateralUsd: string;
  notionalUsd: string;
  /** Signed P&L in USD; positive = profit. */
  unrealizedPnlUsd: string;
  /** Stop-loss price in human-readable USD; null when unset. */
  stopLossUsd: string | null;
  /** Take-profit price in human-readable USD; null when unset. */
  takeProfitUsd: string | null;
  openedAtEpoch: number;
}

export interface IStockPositionsProvider {
  list(traderAddress: `0x${string}`): Promise<StockPosition[]>;
}
