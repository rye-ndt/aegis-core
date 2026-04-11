export function extractAddressFields(inputSchema: Record<string, unknown>): string[] {
  const properties = inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return [];
  return Object.entries(properties)
    .filter(([, def]) => def.type === "address" || def.format === "address")
    .map(([name]) => name);
}
