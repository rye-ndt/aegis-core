/**
 * Shared helpers for Polymarket Gamma response parsing. Gamma serializes some
 * fields (e.g. `outcomes`, `outcomePrices`, `clobTokenIds`) as either a JSON
 * string or a real array depending on the endpoint and version — both the
 * provider and the resolution fetcher need to tolerate both shapes.
 */

export function parseMaybeJsonArray<T = string>(v: string | T[] | undefined | null): T[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
