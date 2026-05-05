import { InlineKeyboard } from "grammy";
import type {
  IntentResult,
  ResultAction,
  ResultField,
  ResultStatus,
} from "../../../../use-cases/interface/input/resultCard.types";
import { getChainName, getExplorerTxUrl } from "../../../../helpers/chainConfig";
import { createLogger } from "../../../../helpers/observability/logger";
import { escapeMd, escapeMdUrl, truncateHash } from "./resultCard.escape";

const log = createLogger("resultCardRender");

const STATUS_EMOJI: Record<ResultStatus, string> = {
  success: "✅",
  pending: "⏳",
  failed: "⚠️",
  // `preview` never reaches Telegram. Kept for type completeness.
  preview: "🔎",
};

const MAX_FIELDS = 5;
const MAX_ACTION_BUTTONS = 3;

export interface RenderedResultCard {
  text: string;
  keyboard?: InlineKeyboard;
  parseMode: "MarkdownV2";
}

export interface RenderInput {
  result: IntentResult;
  /** Optional capability-supplied keyboard appended below auto-built rows. */
  extraKeyboard?: InlineKeyboard;
  /** Optional one-sentence note from the LLM interpreter. */
  interpreterNote?: string | null;
}

export function renderResultCard(input: RenderInput): RenderedResultCard {
  const { result, extraKeyboard, interpreterNote } = input;
  const emoji = STATUS_EMOJI[result.status];

  const lines: string[] = [];
  lines.push(`${emoji} *${escapeMd(result.headline)}*`);

  const fields = result.fields.slice(0, MAX_FIELDS);
  if (fields.length > 0) {
    lines.push("");
    for (const f of fields) lines.push(renderField(f));
  }

  if (interpreterNote) {
    lines.push("");
    lines.push(`_${escapeMd(interpreterNote)}_`);
  }

  // Spec §2.2: only the `internal` code (or no code at all) surfaces the
  // requestId tail. Known catalog codes already speak for themselves; asking
  // the user to quote a support id alongside "That amount is too small" would
  // be noise.
  const isInternal = !result.errorCode || result.errorCode === "internal";
  if (result.status === "failed" && result.requestId && isInternal) {
    lines.push("");
    lines.push(
      escapeMd(
        `If this keeps happening, tell us with code ${result.requestId.slice(0, 8)}`,
      ),
    );
  }

  const actions = (result.nextActions ?? []).slice(0, MAX_ACTION_BUTTONS);
  if (actions.length > 0) {
    lines.push("");
    lines.push(`What's next: ${actions.map((a) => `→ ${escapeMd(a.label)}`).join(" · ")}`);
  }

  const detailsBlock = renderDetails(result);
  if (detailsBlock) {
    lines.push("");
    lines.push(detailsBlock);
  }

  const text = lines.join("\n");
  const keyboard = buildKeyboard(result, extraKeyboard);

  log.debug(
    { verb: result.verb, status: result.status, hasInterpreter: !!interpreterNote },
    "render-result-card",
  );

  return { text, keyboard, parseMode: "MarkdownV2" };
}

function renderField(f: ResultField): string {
  const label = escapeMd(f.label);
  const value = escapeMd(f.value);
  switch (f.emphasis) {
    case "primary":
      return `${label}: *${value}*`;
    case "muted":
      return `_${label}: ${value}_`;
    default:
      return `${label}: ${value}`;
  }
}

function renderDetails(result: IntentResult): string | null {
  const detailFields = result.details ?? [];
  const txHashes = result.txHashes ?? [];
  if (detailFields.length === 0 && txHashes.length === 0) return null;

  const inner: string[] = ["🔍 Details"];
  for (const f of detailFields) inner.push(renderField(f));
  for (const tx of txHashes) {
    const url = getExplorerTxUrl(tx.chainId, tx.hash);
    const label = `🔗 ${truncateHash(tx.hash)} (${getChainName(tx.chainId)})`;
    if (url) {
      inner.push(`[${escapeMd(label)}](${escapeMdUrl(url)})`);
    } else {
      inner.push(escapeMd(label));
    }
  }
  return `||${inner.join("\n")}||`;
}

function buildKeyboard(
  result: IntentResult,
  extra?: InlineKeyboard,
): InlineKeyboard | undefined {
  if (result.status === "preview") {
    // Preview cards never produce a Telegram keyboard — they live inside
    // the mini-app modal which owns its own approve/reject footer.
    return extra;
  }

  const kb = new InlineKeyboard();
  let rowHasButtons = false;

  const actions = (result.nextActions ?? []).slice(0, MAX_ACTION_BUTTONS);
  for (const a of actions) {
    appendAction(kb, a);
    rowHasButtons = true;
  }

  const settlementTx = (result.txHashes ?? []).at(-1);
  if (settlementTx) {
    const url = getExplorerTxUrl(settlementTx.chainId, settlementTx.hash);
    if (url) {
      if (rowHasButtons) kb.row();
      kb.url("🔍 View on explorer", url);
      rowHasButtons = true;
    }
  }

  if (extra) {
    // Augment, never replace. Drop down to a fresh row before appending.
    if (rowHasButtons) kb.row();
    // grammy InlineKeyboard exposes `inline_keyboard` rows; iterate and copy.
    for (const row of extra.inline_keyboard) {
      for (const btn of row) kb.add(btn);
      kb.row();
    }
  }

  return rowHasButtons || extra ? kb : undefined;
}

function appendAction(kb: InlineKeyboard, a: ResultAction): void {
  switch (a.kind) {
    case "url":
      kb.url(a.label, a.payload);
      return;
    case "callback":
      kb.text(a.label, a.payload);
      return;
    case "command":
      // Telegram doesn't reliably support tapping a button to send a slash
      // command. We round-trip via `cmd:` callback data — the telegram input
      // handler strips the prefix and re-dispatches as text input.
      kb.text(a.label, `cmd:${a.payload}`);
      return;
  }
}

