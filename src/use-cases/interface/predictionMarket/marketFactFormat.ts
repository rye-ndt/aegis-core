import type { MarketFact, Operator } from "./MarketFactTypes";

export function opSymbol(op: Operator): string {
  switch (op) {
    case "gte": return "≥";
    case "lte": return "≤";
    case "gt": return ">";
    case "lt": return "<";
    case "eq": return "=";
    case "in": return "∈";
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

export function numericThreshold(fact: MarketFact): number | null {
  if (typeof fact.threshold === "number") return fact.threshold;
  if (typeof fact.threshold === "string") {
    const n = Number(fact.threshold);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function formatThreshold(fact: MarketFact, nullSentinel = "—"): string {
  if (fact.thresholdSet) return `{${fact.thresholdSet.join(",")}}`;
  if (fact.threshold === null) return nullSentinel;
  return String(fact.threshold);
}

export function inferSubject(
  ids: string[],
  subjectByMarket: Map<string, string>,
): string {
  const subjects = new Set<string>();
  for (const id of ids) {
    const s = subjectByMarket.get(id);
    if (s) subjects.add(s);
  }
  if (subjects.size === 1) return Array.from(subjects)[0]!;
  if (subjects.size === 0) return "UNKNOWN";
  return "MIXED";
}
