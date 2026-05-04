/**
 * Converts a human-readable token amount to its raw integer representation.
 * Uses BigInt arithmetic to avoid float precision loss at any decimal count.
 */
export function toRaw(amountHuman: string, decimals: number): string {
  const [intPart, fracPart = ""] = amountHuman.split(".");
  const padded = fracPart.padEnd(decimals, "0").slice(0, decimals);
  const scale = 10n ** BigInt(decimals);
  const raw = BigInt(intPart) * scale + BigInt(padded || "0");
  return raw.toString();
}

/**
 * Divides two human-decimal numbers and returns the quotient as a fixed-point
 * raw integer string with `quotientDecimals` of precision. Pure BigInt math —
 * no floats. Inputs are non-negative human decimal strings (e.g. "189.42").
 *
 *   divFixed("100", "189.42", 10) ≈ "5279801498"   // 0.5279801498 with 1e10 scale
 *
 * Used by /stocks/quote and the Phase 2 stock use-case to size positions
 * from a USD amount + mark price.
 */
export function divFixed(
  numHuman: string,
  denHuman: string,
  quotientDecimals: number,
): string {
  const FIXED = 18;
  const num = BigInt(toRaw(numHuman, FIXED));
  const den = BigInt(toRaw(denHuman, FIXED));
  if (den === 0n) throw new Error("divFixed: division by zero");
  const scale = 10n ** BigInt(quotientDecimals);
  return ((num * scale) / den).toString();
}
