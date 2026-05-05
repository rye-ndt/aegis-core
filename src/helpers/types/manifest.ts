/**
 * Slim manifest shape for in-code capability tools. Survivor of the
 * dynamic-tool-registry removal (see
 * constructions/2026-05-05-drop-dynamic-tool-registry-plan.md). Replaces the
 * heavyweight zod-validated `ToolManifest` for capabilities that are
 * registered in DI rather than persisted in `tool_manifests`.
 */
export type CapabilityManifest = {
  toolId: string;
  /** Human-readable name. Used in autoSign description copy + Telegram confirmations. */
  name: string;
  category: string;
  description: string;
  /** JSON-schema object passed to OpenAISchemaCompiler for LLM param extraction. */
  inputSchema: Record<string, unknown>;
  /**
   * Optional resolver schema. When present and non-empty, the capability runs
   * through the resolver pipeline (`usesDualSchema`). Keys are RESOLVER_FIELD
   * values; structure mirrors the pre-existing ToolManifest contract so
   * downstream consumers (`OpenAISchemaCompiler.compile`) treat it identically.
   */
  requiredFields?: Record<string, unknown>;
};
