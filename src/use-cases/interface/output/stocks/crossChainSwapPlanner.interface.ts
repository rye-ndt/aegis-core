/**
 * Output port — plans a cross-chain swap and returns the unsigned txs plus
 * the expected destination amount.
 *
 * Defined in Phase 1 (interface only) so that Phase 2's `StockUseCase` can
 * take it as a structural dep without referring to the relay client (fix #8).
 *
 * The Phase 2 implementation lives at
 * `be/src/adapters/implementations/output/stocks/relayCrossChainSwapPlanner.ts`
 * and adapts the existing `IRelayClient` to this port shape, returning the
 * post-fee/slippage `currencyOut.amount` as `expectedOutRaw`.
 */
export interface CrossChainSwapPlanInput {
  user: `0x${string}`;
  recipient: `0x${string}`;
  fromChainId: number;
  toChainId: number;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  /** Raw amount in `fromToken` decimals. */
  amountRaw: string;
}

export interface CrossChainSwapPlan {
  txs: ReadonlyArray<{
    to: `0x${string}`;
    data: `0x${string}`;
    value: string;
  }>;
  /** Expected output amount on the destination chain, raw, in `toToken` decimals. */
  expectedOutRaw: string;
}

export interface ICrossChainSwapPlanner {
  plan(input: CrossChainSwapPlanInput): Promise<CrossChainSwapPlan>;
}
