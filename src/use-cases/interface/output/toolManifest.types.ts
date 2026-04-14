import { z } from "zod";
import { TOOL_CATEGORY } from "../../../helpers/enums/toolCategory.enum";
import type { IToolManifestRecord } from "./repository/toolManifest.repo";

// ── Step kinds ────────────────────────────────────────────────────────────────

export const HttpGetStepSchema = z.object({
  kind:    z.literal("http_get"),
  name:    z.string(),
  url:     z.string(),                            // supports {{intent.*}} and {{steps.<name>.*}} templates
  extract: z.record(z.string(), z.string()),      // JSONPath-like: { "calldata": "$.tx.data" }
});

export const HttpPostStepSchema = z.object({
  kind:    z.literal("http_post"),
  name:    z.string(),
  url:     z.string(),
  body:    z.record(z.string(), z.unknown()),
  extract: z.record(z.string(), z.string()),
});

export const AbiEncodeStepSchema = z.object({
  kind:            z.literal("abi_encode"),
  name:            z.string(),
  contractAddress: z.string(),   // validated as valid 0x address at registration
  abiFragment: z.object({
    name:   z.string(),
    inputs: z.array(z.object({ name: z.string(), type: z.string() })),
  }),
  paramMapping: z.record(z.string(), z.string()),
});

export const CalldataPassthroughStepSchema = z.object({
  kind:  z.literal("calldata_passthrough"),
  name:  z.string(),
  to:    z.string(),
  data:  z.string(),
  value: z.string().optional().default("0"),
});

export const Erc20TransferStepSchema = z.object({
  kind: z.literal("erc20_transfer"),
  name: z.string(),
});

export const ToolStepSchema = z.discriminatedUnion("kind", [
  HttpGetStepSchema,
  HttpPostStepSchema,
  AbiEncodeStepSchema,
  CalldataPassthroughStepSchema,
  Erc20TransferStepSchema,
]);

export type ToolStep = z.infer<typeof ToolStepSchema>;

// ── Manifest ──────────────────────────────────────────────────────────────────

export const ToolManifestSchema = z.object({
  toolId:       z.string().min(3).max(64).regex(/^[a-z0-9-]+$/),   // slug
  category:     z.nativeEnum(TOOL_CATEGORY),
  name:         z.string().min(1).max(100),
  description:  z.string().min(10).max(500),
  protocolName: z.string().min(1).max(100),                         // e.g. "Trader Joe V2"
  tags:         z.array(z.string()).min(1),                          // e.g. ["swap", "dex", "avax"]
  priority:     z.number().int().min(0).default(0),                  // higher = preferred in conflicts
  isDefault:    z.boolean().default(false),                          // preferred when no protocol specified
  inputSchema:  z.record(z.string(), z.unknown()),                   // raw JSON Schema — passed to Claude as-is
  steps:        z.array(ToolStepSchema).min(1),
  preflightPreview: z.object({
    label:         z.string(),
    valueTemplate: z.string(),
  }).optional(),
  revenueWallet: z.string().optional(),                             // contributor 0x address
  chainIds:      z.array(z.number()).min(1),
  /**
   * Human-readable schema: the LLM extracts these fields from natural language.
   * Keys must be values of RESOLVER_FIELD enum.
   * Shape: JSON Schema object — same format as inputSchema.
   */
  requiredFields: z.record(z.string(), z.unknown()).optional(),
  /**
   * Machine-readable schema: fields populated by the resolver pipeline after
   * all requiredFields resolvers have run successfully.
   */
  finalSchema: z.record(z.string(), z.unknown()).optional(),
});

export type ToolManifest = z.infer<typeof ToolManifestSchema>;

// ── Deserializer (used in use-case and adapter layers) ────────────────────────

export function deserializeManifest(record: IToolManifestRecord): ToolManifest {
  return {
    toolId:           record.toolId,
    category:         record.category as TOOL_CATEGORY,
    name:             record.name,
    description:      record.description,
    protocolName:     record.protocolName,
    tags:             JSON.parse(record.tags) as string[],
    priority:         record.priority,
    isDefault:        record.isDefault,
    inputSchema:      JSON.parse(record.inputSchema) as Record<string, unknown>,
    steps:            JSON.parse(record.steps) as ToolStep[],
    preflightPreview: record.preflightPreview
      ? JSON.parse(record.preflightPreview)
      : undefined,
    revenueWallet:    record.revenueWallet ?? undefined,
    chainIds:         JSON.parse(record.chainIds) as number[],
    requiredFields:   record.requiredFields ? JSON.parse(record.requiredFields) as Record<string, unknown> : undefined,
    finalSchema:      record.finalSchema    ? JSON.parse(record.finalSchema)    as Record<string, unknown> : undefined,
  };
}
