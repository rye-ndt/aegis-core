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
