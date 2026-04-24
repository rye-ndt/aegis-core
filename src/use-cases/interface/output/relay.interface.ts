/**
 * Cross-chain swap provider (relay.link). Keeps the use-case layer
 * independent of the HTTP transport and Relay's wire format.
 */

export interface RelayQuoteRequest {
  /** SCA / EOA address initiating the swap. */
  user: string;
  /** Destination wallet for the output token. Usually the same as `user`. */
  recipient: string;
  originChainId: number;
  destinationChainId: number;
  /** ERC-20 contract address, or the zero address for native currency. */
  originCurrency: string;
  destinationCurrency: string;
  /** Raw amount (wei-precision string) of the origin token. */
  amount: string;
  tradeType: "EXACT_INPUT" | "EXACT_OUTPUT";
}

export interface RelayTx {
  to: string;
  data: string;
  value: string;
}

/**
 * One step of the quote — typically `approve` or `swap`. The array of
 * `items` flattens into individual transactions the user's wallet must
 * submit. Only the shape consumed by `RelaySwapTool` is declared here;
 * any extra Relay metadata is carried through unchecked.
 */
export interface RelayQuoteStep {
  id?: string;
  action?: string;
  description?: string;
  kind?: string;
  items: Array<{
    status?: string;
    data: RelayTx;
  }>;
}

export interface RelayQuote {
  steps: RelayQuoteStep[];
  details?: {
    currencyIn?: { amount?: string; amountFormatted?: string };
    currencyOut?: { amount?: string; amountFormatted?: string };
  };
  fees?: Record<string, unknown>;
}

export interface IRelayClient {
  getQuote(request: RelayQuoteRequest): Promise<RelayQuote>;
}
