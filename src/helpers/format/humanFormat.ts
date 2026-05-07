/**
 * Plain-English value formatters used by the result-card framework.
 *
 * Capabilities feed pre-formatted strings to `IntentResult.fields` — the
 * renderer never touches numbers. All numeric formatting must go through
 * one of these helpers; do not hand-roll `.toFixed()` or pad-left in caller
 * code. Adding a new formatter? Put it here.
 */

/** Strip trailing zeros after a decimal point ("1.2300" → "1.23", "1.0" → "1"). */
function stripTrailingZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Format a raw token amount (integer string of base units) as a human
 * decimal with the symbol appended. Caps to 6 fractional digits and strips
 * trailing zeros. Returns "0 SYM" for null/empty/undefined raw.
 */
export function formatTokenAmount(
  raw: string,
  decimals: number,
  symbol: string,
): string {
  if (!raw) return `0 ${symbol}`;
  let s = raw;
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (decimals <= 0) {
    return `${negative ? "-" : ""}${s} ${symbol}`;
  }
  const padded = s.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals);
  // Cap to 6 fractional digits for readability — full-precision values live
  // only in the details block when capabilities choose to surface them.
  const fracTrimmed = fracPart.slice(0, 6);
  const combined = stripTrailingZeros(`${intPart}.${fracTrimmed}`);
  return `${negative ? "-" : ""}${combined} ${symbol}`;
}

/** Format a USD value: "<$0.01" for tiny positives, "$5.20" otherwise. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$0.00";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  if (usd < 0 && usd > -0.01) return ">-$0.01";
  const sign = usd < 0 ? "-" : "";
  const abs = Math.abs(usd);
  return `${sign}$${abs.toFixed(2)}`;
}

/** USDC cents → `$X.YZ`. `null`/`undefined` renders as em-dash. */
export function formatUsdcCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return formatUsd(cents / 100);
}

/** Basis-points price (0..10_000) → `$0.42`. `null`/`undefined` renders as em-dash. */
export function formatPriceBps(bps: number | null | undefined): string {
  if (bps == null) return "—";
  return formatUsd(bps / 10_000);
}

/** Signed PnL in cents → `+$1.20` / `-$0.50`. `null`/`undefined` renders as em-dash. */
export function formatPnlCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const sign = cents >= 0 ? "+" : "";
  return `${sign}${formatUsd(cents / 100)}`;
}

/**
 * Relative-time formatter ("just now", "3 min ago", "2 hours ago", "5 days ago").
 * Capabilities pass an absolute epoch in seconds; we compute the delta against
 * the current wall-clock here.
 */
export function formatRelativeTime(epochSec: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const delta = nowSec - epochSec;
  if (delta < 30) return "just now";
  if (delta < 60) return `${delta} sec ago`;
  const min = Math.floor(delta / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

/** Duration formatter for "took N seconds" / "took N minutes" lines. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 sec";
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100) * 100 / 1000)} sec`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} sec`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.round(min / 60);
  return `${hr} hr`;
}

/** First 6 + last 4 of post-`0x`. Mirror of resultCard.escape's helper for non-renderer callers. */
export function truncateHash(hash: string): string {
  const stripped = hash.startsWith("0x") ? hash.slice(2) : hash;
  if (stripped.length <= 10) return `0x${stripped}`;
  return `0x${stripped.slice(0, 6)}…${stripped.slice(-4)}`;
}
