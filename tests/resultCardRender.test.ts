/**
 * Snapshot-style tests for `resultCard.render.ts`. We don't use a snapshot
 * fixture file — the assertions are explicit `assert.equal` calls so any
 * format drift is visible at the diff site.
 *
 * Run with: npx tsx --test tests/resultCardRender.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderResultCard } from "../src/adapters/implementations/output/artifactRenderer/resultCard.render";
import type { IntentResult } from "../src/use-cases/interface/input/resultCard.types";

function base(overrides: Partial<IntentResult>): IntentResult {
  return {
    status: "success",
    verb: "send",
    headline: "test",
    fields: [],
    ...overrides,
  } as IntentResult;
}

test("success: emoji + bold headline + escaped value", () => {
  const out = renderResultCard({
    result: base({
      status: "success",
      verb: "send",
      headline: "You sent 5 USDC",
      fields: [{ label: "To", value: "0xabc.def" }],
    }),
  });
  assert.equal(out.parseMode, "MarkdownV2");
  assert.match(out.text, /^✅ \*You sent 5 USDC\*/);
  assert.match(out.text, /To: 0xabc\\\.def/);
});

test("failed: warn emoji + requestId tail line (no code = internal-equivalent)", () => {
  const out = renderResultCard({
    result: base({
      status: "failed",
      verb: "swap",
      headline: "Swap failed",
      fields: [{ label: "Reason", value: "x" }],
      requestId: "12345678-aaaa-bbbb-cccc-deadbeef0000",
    }),
  });
  assert.match(out.text, /^⚠️ \*Swap failed\*/);
  assert.match(out.text, /code 12345678/);
});

test("failed: errorCode==='internal' shows requestId tail", () => {
  const out = renderResultCard({
    result: base({
      status: "failed",
      verb: "swap",
      headline: "Swap failed",
      fields: [],
      requestId: "abcdefab-aaaa-bbbb-cccc-deadbeef0000",
      errorCode: "internal",
    }),
  });
  assert.match(out.text, /code abcdefab/);
});

test("failed: known errorCode (e.g. amount_too_low) hides requestId tail", () => {
  const out = renderResultCard({
    result: base({
      status: "failed",
      verb: "swap",
      headline: "Amount too low",
      fields: [{ label: "Reason", value: "Try at least $1" }],
      requestId: "12345678-aaaa-bbbb-cccc-deadbeef0000",
      errorCode: "amount_too_low",
    }),
  });
  assert.doesNotMatch(out.text, /code 12345678/);
  assert.doesNotMatch(out.text, /If this keeps happening/);
});

test("pending: hourglass emoji", () => {
  const out = renderResultCard({
    result: base({ status: "pending", verb: "swap", headline: "Working on it", fields: [] }),
  });
  assert.match(out.text, /^⏳/);
});

test("preview: no keyboard is built", () => {
  const out = renderResultCard({
    result: base({
      status: "preview",
      verb: "swap",
      headline: "Swap 5 USDC",
      fields: [{ label: "Rate", value: "1=1" }],
      nextActions: [{ label: "x", kind: "callback", payload: "y" }],
    }),
  });
  // Preview never produces a keyboard from nextActions.
  assert.equal(out.keyboard, undefined);
});

test("primary emphasis bolds the value", () => {
  const out = renderResultCard({
    result: base({
      headline: "h",
      fields: [{ label: "Amount", value: "5 USDC", emphasis: "primary" }],
    }),
  });
  assert.match(out.text, /Amount: \*5 USDC\*/);
});

test("muted emphasis italicises the whole pair", () => {
  const out = renderResultCard({
    result: base({
      headline: "h",
      fields: [{ label: "Took", value: "3s", emphasis: "muted" }],
    }),
  });
  assert.match(out.text, /_Took: 3s_/);
});

test("nextActions render as `What's next` line + keyboard buttons", () => {
  const out = renderResultCard({
    result: base({
      headline: "h",
      fields: [],
      nextActions: [
        { label: "Earn yield", kind: "command", payload: "/yield" },
        { label: "Swap again", kind: "command", payload: "/swap" },
      ],
    }),
  });
  assert.match(out.text, /What's next:/);
  assert.match(out.text, /→ Earn yield/);
  assert.ok(out.keyboard);
  const rows = out.keyboard!.inline_keyboard;
  // Both command actions become callback buttons with `cmd:` prefix.
  const flat = rows.flat();
  const cmdBtns = flat.filter((b: any) => b.callback_data?.startsWith("cmd:"));
  assert.equal(cmdBtns.length, 2);
});

test("txHashes produce explorer button + spoiler details block", () => {
  const out = renderResultCard({
    result: base({
      headline: "Swap done",
      fields: [],
      txHashes: [{ hash: "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", chainId: 43114 }],
    }),
  });
  assert.match(out.text, /\|\|🔍 Details/);
  assert.match(out.text, /\|\|/);
  assert.ok(out.keyboard);
  const flat = out.keyboard!.inline_keyboard.flat() as any[];
  const explorer = flat.find((b) => b.text?.includes("View on explorer"));
  assert.ok(explorer);
  assert.match(explorer.url, /^https:/);
});

test("interpreterNote renders as italic line", () => {
  const out = renderResultCard({
    result: base({ headline: "h", fields: [] }),
    interpreterNote: "You sent 5 USDC to your friend.",
  });
  assert.match(out.text, /_You sent 5 USDC to your friend\\\._/);
});

test("MarkdownV2 special chars are escaped in fields and headline", () => {
  const out = renderResultCard({
    result: base({
      headline: "Hello (world)!",
      fields: [{ label: "k.", value: "v[1]" }],
    }),
  });
  // Parens, brackets, period, exclamation are MarkdownV2-significant.
  assert.match(out.text, /Hello \\\(world\\\)\\!/);
  assert.match(out.text, /k\\\./);
  assert.match(out.text, /v\\\[1\\\]/);
});

test("max 5 fields enforced, rest dropped", () => {
  const fields = Array.from({ length: 8 }, (_, i) => ({
    label: `f${i}`,
    value: `v${i}`,
  }));
  const out = renderResultCard({
    result: base({ headline: "h", fields }),
  });
  // Only the first 5 should appear.
  assert.match(out.text, /f0:/);
  assert.match(out.text, /f4:/);
  assert.doesNotMatch(out.text, /f5:/);
});

test("max 3 next-action buttons, rest dropped", () => {
  const out = renderResultCard({
    result: base({
      headline: "h",
      fields: [],
      nextActions: [
        { label: "a", kind: "callback", payload: "1" },
        { label: "b", kind: "callback", payload: "2" },
        { label: "c", kind: "callback", payload: "3" },
        { label: "d", kind: "callback", payload: "4" },
      ],
    }),
  });
  const flat = out.keyboard!.inline_keyboard.flat() as any[];
  assert.equal(flat.filter((b) => b.callback_data).length, 3);
});

test("recovery details block contains both detail fields and tx hashes", () => {
  const out = renderResultCard({
    result: base({
      headline: "h",
      fields: [],
      details: [{ label: "Route", value: "Aave→Benqi" }],
      txHashes: [
        { hash: "0x" + "f".repeat(64), chainId: 43114 },
      ],
    }),
  });
  assert.match(out.text, /Route: Aave/);
  assert.match(out.text, /\|\|.*Route.*🔗.*\|\|/s);
});
