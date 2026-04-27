import { extractAddressFields } from "../../../../helpers/schema/addressFields";
import type { ITokenRecord, ToolManifest } from "../../../../use-cases/interface/input/intent.interface";

// Matches:
//   "$5", "$5.00", "$ 5", "$ 5.5"     — dollar-sign prefix, decimals optional
//   "5 dollars", "5.5 bucks", "10 usd", "3.50 usdc"
// Previously the dollar-sign branch required a decimal portion (`(\.\d+)`),
// which silently broke the most common case `/send $5 to …`.
const FIAT_PATTERN = /\$\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:dollars?|bucks?|usdc?|usd)\b/i;

/**
 * Returns true when the message clearly expresses a fiat/stablecoin amount,
 * e.g. "$5", "5 dollars", "5 bucks", "10 usd", "3.50 usdc".
 * Used to auto-inject USDC when no token symbol was specified.
 */
export function detectStablecoinIntent(text: string): boolean {
  return FIAT_PATTERN.test(text);
}

/** Picks a token from a disambiguation list by 1-based index or symbol match. */
export function pickCandidateByInput(
  input: string,
  candidates: ITokenRecord[],
): ITokenRecord | undefined {
  const idx = parseInt(input, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= candidates.length) return candidates[idx - 1];
  const upper = input.trim().toUpperCase();
  return candidates.find((c) => c.symbol.toUpperCase() === upper);
}

export function getMissingRequiredFields(
  manifest: ToolManifest,
  partialParams: Record<string, unknown>,
): string[] {
  const inputSchema = manifest.inputSchema as Record<string, unknown>;
  const required = (inputSchema.required as string[] | undefined) ?? [];
  const addressFields = new Set(extractAddressFields(inputSchema));
  return required.filter(
    (f) =>
      !addressFields.has(f) &&
      (partialParams[f] === undefined || partialParams[f] === null || partialParams[f] === ""),
  );
}
