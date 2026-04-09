import type { IntentPackage } from "../../../../../use-cases/interface/output/intentParser.interface";

export type TemplateContext = {
  intent: IntentPackage;
  user:   { scaAddress: string };
  steps:  Record<string, Record<string, string>>;
};

export class TemplateResolutionError extends Error {
  constructor(path: string) {
    super(`Template resolution failed: "{{${path}}}" not found in context`);
    this.name = "TemplateResolutionError";
  }
}

const TEMPLATE_RE = /\{\{([^}]+)\}\}/g;

function getNestedValue(obj: unknown, path: string): string | undefined {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  if (current == null) return undefined;
  return String(current);
}

export function resolve(template: string, ctx: TemplateContext): string {
  return template.replace(TEMPLATE_RE, (_, path: string) => {
    const value = getNestedValue(ctx, path.trim());
    if (value === undefined) throw new TemplateResolutionError(path.trim());
    return value;
  });
}

export function resolveRecord(
  obj: Record<string, string>,
  ctx: TemplateContext,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolve(value, ctx);
  }
  return result;
}
