import type { StructuredToolPayload } from "../../../../use-cases/interface/output/tool.interface";
import type {
  IntentResult,
  ResultField,
} from "../../../../use-cases/interface/input/resultCard.types";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("assistantResultRouter");

const MAX_FIELDS = 5;

/**
 * Maps a `StructuredToolPayload` produced by a read-only tool into an
 * `IntentResult` so `AssistantChatCapability` can emit a `result_card`
 * instead of forwarding the LLM's markdown-table prose. Returns `null` when
 * no known shape matches — the capability falls back to `kind:"chat"`.
 *
 * The router is intentionally side-effect-free: same payload in, same card
 * out. All formatting decisions (truncation, "Show details" splits) live
 * here so capabilities don't reinvent them.
 */
export function routeStructuredToolResult(
  toolName: string,
  payload: StructuredToolPayload,
): IntentResult | null {
  log.debug({ toolName, kind: payload.kind }, "route-structured");

  switch (payload.kind) {
    case "transfer_history":
      return routeTransferHistory(payload);
    case "stock_positions":
      return routeStockPositions(payload);
    case "stock_quote":
      return routeStockQuote(payload);
    case "portfolio":
      return routePortfolio(payload);
    default:
      return null;
  }
}

function shortAddr(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function relativeTime(epoch: number): string {
  const diff = newCurrentUTCEpoch() - epoch;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return "yesterday";
  return `${Math.floor(diff / 86400)}d ago`;
}

function routeTransferHistory(
  payload: Extract<StructuredToolPayload, { kind: "transfer_history" }>,
): IntentResult {
  const items = payload.items;
  if (items.length === 0) {
    return {
      status: "success",
      verb: "history_query",
      headline: "No recent transfers",
      fields: [
        { label: "Status", value: "Nothing in the window you asked about", emphasis: "muted" },
      ],
      complexity: "simple",
    };
  }

  const head = items.slice(0, MAX_FIELDS);
  const tail = items.slice(MAX_FIELDS);
  const fields: ResultField[] = head.map((it) => ({
    label:
      it.direction === "in"
        ? `Received ${it.amountFormatted} ${it.tokenSymbol}`
        : it.direction === "out"
          ? `Sent ${it.amountFormatted} ${it.tokenSymbol}`
          : `Self-transfer ${it.amountFormatted} ${it.tokenSymbol}`,
    value: `${it.direction === "out" ? "→ " : "← "}${shortAddr(it.counterparty)} · ${relativeTime(it.timestampEpoch)}`,
  }));

  const details: ResultField[] = tail.map((it) => ({
    label: `${it.direction === "in" ? "Received" : it.direction === "out" ? "Sent" : "Self"} ${it.amountFormatted} ${it.tokenSymbol}`,
    value: `${shortAddr(it.counterparty)} · ${relativeTime(it.timestampEpoch)}`,
  }));

  return {
    status: "success",
    verb: "history_query",
    headline: `Recent transfers: ${items.length}${payload.nextCursor ? "+" : ""}`,
    fields,
    details: details.length > 0 ? details : undefined,
    txHashes: head
      .map((it) => ({ hash: it.txHash, chainId: it.chainId }))
      .slice(0, 3),
    complexity: "simple",
  };
}

function routeStockPositions(
  payload: Extract<StructuredToolPayload, { kind: "stock_positions" }>,
): IntentResult {
  const items = payload.items;
  if (items.length === 0) {
    return {
      status: "success",
      verb: "positions_query",
      headline: "No open stock positions",
      fields: [
        { label: "Status", value: "Nothing open right now", emphasis: "muted" },
      ],
      nextActions: [{ label: "Browse stocks", kind: "command", payload: "/stock" }],
      complexity: "simple",
    };
  }
  const head = items.slice(0, MAX_FIELDS);
  const tail = items.slice(MAX_FIELDS);
  const fmt = (p: typeof items[number]): ResultField => {
    const sign = p.unrealizedPnlUsd.startsWith("-") ? "" : "+";
    return {
      label: `${p.symbol} (${p.side})`,
      value: `Mark $${p.markPriceUsd} · P&L ${sign}$${p.unrealizedPnlUsd}`,
    };
  };
  return {
    status: "success",
    verb: "positions_query",
    headline: `Open positions: ${items.length}`,
    fields: head.map(fmt),
    details: tail.length > 0 ? tail.map(fmt) : undefined,
    nextActions: [{ label: "Open another", kind: "command", payload: "/stock" }],
    complexity: "simple",
  };
}

function routeStockQuote(
  payload: Extract<StructuredToolPayload, { kind: "stock_quote" }>,
): IntentResult {
  const items = payload.items;
  if (items.length === 0) {
    return {
      status: "success",
      verb: "balance_query",
      headline: "No marks available",
      fields: [
        { label: "Status", value: "Try again in a moment", emphasis: "muted" },
      ],
      complexity: "simple",
    };
  }
  const head = items.slice(0, MAX_FIELDS);
  const tail = items.slice(MAX_FIELDS);
  const fmt = (m: typeof items[number]): ResultField => ({
    label: m.symbol,
    value: `$${m.priceUsd}`,
    emphasis: "primary",
  });
  return {
    status: "success",
    verb: "balance_query",
    headline: items.length === 1 ? `${items[0]!.symbol} quote` : `Stock quotes: ${items.length}`,
    fields: head.map(fmt),
    details: tail.length > 0 ? tail.map(fmt) : undefined,
    nextActions: [{ label: "Buy this", kind: "command", payload: "/stock" }],
    complexity: "simple",
  };
}

function routePortfolio(
  payload: Extract<StructuredToolPayload, { kind: "portfolio" }>,
): IntentResult {
  const balances = payload.balances;
  const totalUsd = balances.reduce((s, b) => s + (b.usdValue ?? 0), 0);
  const fmt = (b: typeof balances[number]): ResultField => ({
    label: b.symbol,
    value:
      b.usdValue != null
        ? `${b.balance} (≈ $${b.usdValue.toFixed(2)})`
        : `${b.balance}`,
  });
  if (balances.length === 0) {
    return {
      status: "success",
      verb: "portfolio_summary",
      headline: "Empty wallet",
      fields: [
        { label: "Wallet", value: shortAddr(payload.walletAddress) },
        { label: "Status", value: "Nothing held yet", emphasis: "muted" },
      ],
      nextActions: [{ label: "Top up", kind: "command", payload: "/buy" }],
      complexity: "simple",
    };
  }
  // Sort by USD value desc so the most valuable holdings show in the head.
  const sorted = [...balances].sort(
    (a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0),
  );
  const head = sorted.slice(0, MAX_FIELDS);
  const tail = sorted.slice(MAX_FIELDS);
  return {
    status: "success",
    verb: "portfolio_summary",
    headline: `Portfolio: $${totalUsd.toFixed(2)}`,
    fields: [
      {
        label: "Total",
        value: `≈ $${totalUsd.toFixed(2)}`,
        emphasis: "primary" as const,
      },
      ...head.map(fmt),
    ].slice(0, MAX_FIELDS),
    details: tail.length > 0 ? tail.map(fmt) : undefined,
    nextActions: [
      { label: "Earn yield", kind: "command", payload: "/yield" },
      { label: "Send", kind: "command", payload: "/send" },
    ],
    complexity: "simple",
  };
}
