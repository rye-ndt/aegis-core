/**
 * Unit tests for assistantResultRouter — verifies that structured tool
 * payloads round-trip into IntentResult cards with the expected verbs and
 * shape. Drives §5.2.5 of the result-card framework plan.
 *
 * Run with: npx tsx --test tests/assistantResultRouter.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { routeStructuredToolResult } from "../src/adapters/implementations/output/capabilities/assistantResultRouter";

test("transfer_history empty → success card with muted status", () => {
  const card = routeStructuredToolResult("get_transfer_history", {
    kind: "transfer_history",
    items: [],
    nextCursor: null,
  });
  assert.ok(card);
  assert.equal(card!.verb, "history_query");
  assert.equal(card!.status, "success");
  assert.match(card!.headline, /No recent transfers/);
});

test("transfer_history with items → fields head + tx hashes", () => {
  const now = Math.floor(Date.now() / 1000);
  const card = routeStructuredToolResult("get_transfer_history", {
    kind: "transfer_history",
    items: [
      {
        direction: "out",
        tokenSymbol: "USDC",
        amountFormatted: "5",
        counterparty: "0xabcdef0123456789abcdef0123456789abcdef01",
        timestampEpoch: now - 3600,
        txHash: "0x" + "f".repeat(64),
        chainId: 43114,
      },
    ],
  });
  assert.ok(card);
  assert.equal(card!.verb, "history_query");
  assert.equal(card!.fields.length, 1);
  assert.match(card!.fields[0]!.label, /Sent 5 USDC/);
  assert.equal(card!.txHashes?.length, 1);
});

test("stock_positions empty → 'No open' headline + browse CTA", () => {
  const card = routeStructuredToolResult("get_stock_positions", {
    kind: "stock_positions",
    items: [],
  });
  assert.ok(card);
  assert.equal(card!.verb, "positions_query");
  assert.equal(card!.nextActions?.[0]?.payload, "/stock");
});

test("stock_positions with items → P&L formatted with sign", () => {
  const card = routeStructuredToolResult("get_stock_positions", {
    kind: "stock_positions",
    items: [
      {
        symbol: "AAPL",
        side: "long",
        entryPriceUsd: "180",
        markPriceUsd: "190",
        collateralUsd: "100",
        unrealizedPnlUsd: "5.50",
        tradeHash: "0x" + "a".repeat(64),
      },
    ],
  });
  assert.ok(card);
  assert.match(card!.fields[0]!.value, /\+\$5\.50/);
});

test("stock_quote single symbol → single-symbol headline", () => {
  const card = routeStructuredToolResult("get_stock_quote", {
    kind: "stock_quote",
    items: [{ symbol: "TSLA", priceUsd: "245.00", asOfEpoch: 0 }],
  });
  assert.ok(card);
  assert.match(card!.headline, /TSLA quote/);
});

test("portfolio sorts balances by usdValue desc + total in headline", () => {
  const card = routeStructuredToolResult("get_portfolio", {
    kind: "portfolio",
    walletAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
    walletLabel: "SCA",
    balances: [
      { symbol: "AVAX", balance: "1.0", usdValue: 25 },
      { symbol: "USDC", balance: "100", usdValue: 100 },
    ],
  });
  assert.ok(card);
  assert.match(card!.headline, /\$125\.00/);
  // First field is "Total"; second should be USDC (highest usdValue).
  assert.equal(card!.fields[0]!.label, "Total");
  assert.equal(card!.fields[1]!.label, "USDC");
});

test("portfolio empty → wallet shortened, top-up CTA", () => {
  const card = routeStructuredToolResult("get_portfolio", {
    kind: "portfolio",
    walletAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
    walletLabel: "SCA",
    balances: [],
  });
  assert.ok(card);
  assert.equal(card!.verb, "portfolio_summary");
  assert.equal(card!.nextActions?.[0]?.payload, "/buy");
});
