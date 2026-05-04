/**
 * Output port — adapts a tokenized-stock perpetuals venue (Aster on BSC in
 * v0) to a chain-agnostic interface. The use-case never touches viem or the
 * Diamond directly; everything goes through this port.
 */

export interface UnsignedTx {
  to: `0x${string}`;
  data: `0x${string}`;
  /** Raw value as decimal string. "0" for non-payable. */
  value: string;
}

export interface OpenPositionParams {
  traderAddress: `0x${string}`;
  symbol: string;
  isLong: boolean;
  /** Collateral in venue-token decimals, raw integer string. */
  collateralAmountRaw: string;
  /** Position size, fixed-point 1e10. Pre-computed by the use-case. */
  qtyFixed1e10: string;
  /** Mark price, fixed-point 1e8. */
  markPriceFixed1e8: string;
  /** Optional SL/TP, fixed-point 1e8. Pass undefined for unset. */
  stopLossFixed1e8?: string;
  takeProfitFixed1e8?: string;
}

export interface ClosePositionParams {
  tradeHash: `0x${string}`;
}

export interface SetExitsParams {
  tradeHash: `0x${string}`;
  /** Fixed-point 1e8. "0" = unset. */
  stopLossFixed1e8: string;
  takeProfitFixed1e8: string;
}

export interface IStockBrokerProvider {
  readonly venueChainId: number;
  readonly diamondAddress: `0x${string}`;
  readonly collateralToken: {
    address: `0x${string}`;
    decimals: number;
    symbol: string;
  };

  /** [maybe approve, openMarketTrade]. */
  buildOpenPositionTxs(p: OpenPositionParams): Promise<UnsignedTx[]>;
  /** [closeTrade]. */
  buildClosePositionTxs(p: ClosePositionParams): Promise<UnsignedTx[]>;
  /** [updateTradeTpAndSl]. */
  buildSetExitsTxs(p: SetExitsParams): Promise<UnsignedTx[]>;

  /** True when the trader has approved at least `requiredAmountRaw` to the diamond. */
  hasApproval(
    traderAddress: `0x${string}`,
    requiredAmountRaw: string,
  ): Promise<boolean>;

  /**
   * Read the trader's venue-chain collateral-token balance, raw.
   * Used by the recovery flow (fix #7 — keeps `venuePublicClient` out of the use-case).
   */
  getCollateralBalance(traderAddress: `0x${string}`): Promise<bigint>;
}
