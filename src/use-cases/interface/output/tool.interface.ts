export interface IToolInput {
  [key: string]: unknown;
}

/**
 * A typed structured payload optionally returned alongside the tool's
 * markdown `data`. Read-only tools that the result-card framework knows how
 * to render directly (transfer history, balances, stock positions/quotes,
 * portfolio summary) populate this so `assistantResultRouter` can build a
 * `result_card` instead of letting the LLM re-format the markdown table.
 *
 * The LLM still receives `data` (string) in its tool-result message — it
 * keeps seeing a human-readable table for context — but the capability
 * suppresses the LLM's prose when a structured payload is present and emits
 * the structured card instead.
 */
export type StructuredToolPayload =
  | { kind: "transfer_history"; items: Array<{
      direction: "in" | "out" | "self";
      tokenSymbol: string;
      amountFormatted: string;
      counterparty: string;
      timestampEpoch: number;
      txHash: string;
      chainId: number;
      label?: string | null;
    }>; nextCursor?: string | null }
  | { kind: "stock_positions"; items: Array<{
      symbol: string;
      side: "long" | "short";
      entryPriceUsd: string;
      markPriceUsd: string;
      collateralUsd: string;
      unrealizedPnlUsd: string;
      stopLossUsd?: string | null;
      takeProfitUsd?: string | null;
      tradeHash: string;
    }> }
  | { kind: "stock_quote"; items: Array<{
      symbol: string;
      priceUsd: string;
      asOfEpoch: number;
    }> }
  | { kind: "portfolio"; walletAddress: string; walletLabel: string; balances: Array<{
      symbol: string;
      balance: string;
      usdValue: number | null;
    }> };

export interface IToolOutput {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Optional structured payload for the assistantResultRouter. */
  structured?: StructuredToolPayload;
}

export interface IToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool's expected input */
  inputSchema: Record<string, unknown>;
}

export interface ITool {
  definition(): IToolDefinition;
  execute(input: IToolInput): Promise<IToolOutput>;
}

export interface IToolRegistry {
  register(tool: ITool): void;
  getAll(): ITool[];
  getByName(name: string): ITool | undefined;
}
