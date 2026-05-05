export type ResultStatus = "success" | "pending" | "failed" | "preview";

export type IntentVerb =
  | "send"
  | "swap"
  | "yield_deposit"
  | "yield_withdraw"
  | "yield_rebalance"
  | "stock_buy"
  | "stock_close"
  | "stock_set_exits"
  | "buy_onramp"
  | "history_query"
  | "balance_query"
  | "positions_query"
  | "portfolio_summary"
  | "loyalty_query";

export interface ResultField {
  label: string;
  value: string;
  emphasis?: "primary" | "normal" | "muted";
}

export interface ResultAction {
  label: string;
  kind: "command" | "callback" | "url";
  payload: string;
}

export interface IntentResult {
  status: ResultStatus;
  verb: IntentVerb;
  headline: string;
  fields: ResultField[];
  txHashes?: { hash: string; chainId: number }[];
  nextActions?: ResultAction[];
  complexity?: "simple" | "complex";
  interpreterContext?: Record<string, unknown>;
  details?: ResultField[];
  requestId?: string;
  /**
   * Optional error-catalog code for `failed` cards. Drives the renderer's
   * "tell us with code <id>" tail line, which is only emitted when the code
   * is `"internal"` (or unspecified) per spec §2.2 — known/recoverable codes
   * already have human-readable `friendly` text and shouldn't ask the user
   * for an opaque support id.
   */
  errorCode?: string;
}
