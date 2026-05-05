/**
 * Telegram MarkdownV2 escape helper. The renderer is the ONLY place that
 * touches MarkdownV2 — capabilities hand the renderer plain strings and the
 * renderer calls `escapeMd` on every user-supplied substring before
 * embedding it into a markdown template.
 *
 * Per Telegram docs, the following chars must be escaped in MarkdownV2 body
 * text: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
const MD_V2_SPECIALS = /[_*\[\]()~`>#+\-=|{}.!]/g;

export function escapeMd(input: string): string {
  return input.replace(MD_V2_SPECIALS, (c) => `\\${c}`);
}

/**
 * Escape the URL portion of a `[label](url)` link. Only `)` and `\` need
 * escaping inside the parens per MarkdownV2 spec.
 */
export function escapeMdUrl(url: string): string {
  return url.replace(/[)\\]/g, (c) => `\\${c}`);
}

/** First 6 + last 4 of post-`0x` for a tx hash. Returns "0xabcd…1234". */
export function truncateHash(hash: string): string {
  const stripped = hash.startsWith("0x") ? hash.slice(2) : hash;
  if (stripped.length <= 10) return `0x${stripped}`;
  return `0x${stripped.slice(0, 6)}…${stripped.slice(-4)}`;
}
