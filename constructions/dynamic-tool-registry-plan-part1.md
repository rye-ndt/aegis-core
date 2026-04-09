# Dynamic Tool Registry — Part 1: Type System & DB Foundation

> **Stage**: 1 of 3  
> **Prerequisite**: None — implement this first.  
> **Constraint**: This part is **purely declarative** — enums, interfaces, Zod schemas, and the DB schema. Zero runtime logic. Zero HTTP. Zero solver code. After this part compiles cleanly, move to Part 2.

---

## Scope

| Creates | Modifies |
|---|---|
| `TOOL_CATEGORY` enum | `intentParser.interface.ts` (widen action, add params, add relevantManifests param) |
| `toolManifest.types.ts` (Zod schemas + deserializer) | `toolManifest.repo.ts` (rewrite interface) |
| | `schema.ts` (replace toolManifests table) |
| | `openai.intentParser.ts` (signature compliance only) |
| | DB migration (auto-generated) |

**Do not touch** solver files, use case implementations, HTTP server, or DI wiring in this part.

---

## Step 1 — Define the type system (no DB, no logic)

### 1a. New enum `src/helpers/enums/toolCategory.enum.ts`

```typescript
export enum TOOL_CATEGORY {
  ERC20_TRANSFER       = "erc20_transfer",
  SWAP                 = "swap",
  CONTRACT_INTERACTION = "contract_interaction",
}
```

Separate from `SOLVER_TYPE` and `INTENT_ACTION`. Classifies the *kind of execution* and drives which security policies apply.

### 1b. New file `src/use-cases/interface/output/toolManifest.types.ts`

Define the discriminated-union step schema, the manifest schema, and the `deserializeManifest` helper. Everything in this file is pure Zod/TypeScript — no imports from adapters.

```typescript
import { z } from "zod";
import { TOOL_CATEGORY } from "../../../helpers/enums/toolCategory.enum";
import type { IToolManifestRecord } from "./repository/toolManifest.repo";

// ── Step kinds ────────────────────────────────────────────────────────────────

export const HttpGetStepSchema = z.object({
  kind:    z.literal("http_get"),
  name:    z.string(),
  url:     z.string(),           // supports {{intent.*}} and {{steps.<name>.*}} templates
  extract: z.record(z.string()), // JSONPath-like: { "calldata": "$.tx.data" }
});

export const HttpPostStepSchema = z.object({
  kind:    z.literal("http_post"),
  name:    z.string(),
  url:     z.string(),
  body:    z.record(z.unknown()),
  extract: z.record(z.string()),
});

export const AbiEncodeStepSchema = z.object({
  kind:            z.literal("abi_encode"),
  name:            z.string(),
  contractAddress: z.string(),   // validated as valid 0x address at registration
  abiFragment: z.object({
    name:   z.string(),
    inputs: z.array(z.object({ name: z.string(), type: z.string() })),
  }),
  paramMapping: z.record(z.string()),
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
  // params always come from intent.fromToken, intent.recipient, intent.amountRaw
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
  inputSchema:  z.record(z.unknown()),                               // raw JSON Schema — passed to Claude as-is
  steps:        z.array(ToolStepSchema).min(1),
  preflightPreview: z.object({
    label:         z.string(),
    valueTemplate: z.string(),
  }).optional(),
  revenueWallet: z.string().optional(),                             // contributor 0x address
  chainIds:      z.array(z.number()).min(1),
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
  };
}
```

**Why `inputSchema` is `record(unknown)` not typed**: raw JSON Schema passed verbatim to Claude's tool_use definitions. Typing its internals would be over-engineering.

### 1c. Update `IntentPackage` in `src/use-cases/interface/output/intentParser.interface.ts`

Widen `action` from `INTENT_ACTION` to `string`. Add `params?`. `INTENT_ACTION` enum is NOT removed — it remains the narrowing tool in the validator and use case. It just no longer exhausts all possible values of `action`.

```typescript
export interface IntentPackage {
  action:           string;          // INTENT_ACTION value OR dynamic toolId
  fromTokenSymbol?: string;
  toTokenSymbol?:   string;
  amountHuman?:     string;
  slippageBps?:     number;
  recipient?:       Address;
  params?:          Record<string, unknown>; // extra fields for dynamic tools
  confidence:       number;
  rawInput:         string;
}
```

### 1d. Update `IIntentParser` signature in the same file

Add `relevantManifests` as an optional third parameter. This is the hexagonal-clean way to pass tool discovery results from the use case to the adapter.

```typescript
import type { ToolManifest } from "./toolManifest.types";

export interface IIntentParser {
  parse(
    messages: string[],
    userId: string,
    relevantManifests?: ToolManifest[],   // ADD — injected by IntentUseCaseImpl
  ): Promise<IntentPackage | null>;
}
```

### 1e. Update `OpenAIIntentParser` signature — `src/adapters/implementations/output/intentParser/openai.intentParser.ts`

Accept the extra param and ignore it. This is signature compliance only — existing behavior is unchanged.

```typescript
// Change only the method signature line:
async parse(
  messages: string[],
  userId: string,
  _relevantManifests?: ToolManifest[],   // accepted, ignored
): Promise<IntentPackage | null>
```

---

## Step 2 — DB migration

### 2a. Update `schema.ts`

Replace the existing `toolManifests` table definition entirely. Columns removed vs. current: `display_name`, `version`, `solver_type`, `endpoint_url`, `output_schema`, `rev_share_bps`. Columns added: `tool_id`, `category`, `protocol_name`, `tags`, `priority`, `is_default`, `steps`, `preflight_preview`, `revenue_wallet`, `is_verified`.

```typescript
export const toolManifests = pgTable("tool_manifests", {
  id:               uuid("id").primaryKey(),
  toolId:           text("tool_id").notNull().unique(),     // slug, external key
  category:         text("category").notNull(),              // TOOL_CATEGORY
  name:             text("name").notNull(),
  description:      text("description").notNull(),
  protocolName:     text("protocol_name").notNull(),
  tags:             text("tags").notNull(),                  // JSON string of string[]
  priority:         integer("priority").notNull().default(0),
  isDefault:        boolean("is_default").notNull().default(false),
  inputSchema:      text("input_schema").notNull(),          // JSON string of JSON Schema
  steps:            text("steps").notNull(),                 // JSON string of ToolStep[]
  preflightPreview: text("preflight_preview"),               // JSON string or null
  revenueWallet:    text("revenue_wallet"),
  isVerified:       boolean("is_verified").notNull().default(false),
  isActive:         boolean("is_active").notNull().default(true),
  chainIds:         text("chain_ids").notNull(),             // JSON string of number[]
  createdAtEpoch:   integer("created_at_epoch").notNull(),
  updatedAtEpoch:   integer("updated_at_epoch").notNull(),
});
```

Run `npm run db:generate && npm run db:migrate`.

### 2b. Rewrite `IToolManifestRecord` and `IToolManifestDB` — `src/use-cases/interface/output/repository/toolManifest.repo.ts`

```typescript
export interface IToolManifestRecord {
  id:               string;
  toolId:           string;
  category:         string;
  name:             string;
  description:      string;
  protocolName:     string;
  tags:             string;   // raw JSON string of string[]
  priority:         number;
  isDefault:        boolean;
  inputSchema:      string;   // raw JSON string
  steps:            string;   // raw JSON string
  preflightPreview: string | null;
  revenueWallet:    string | null;
  isVerified:       boolean;
  isActive:         boolean;
  chainIds:         string;   // raw JSON string of number[]
  createdAtEpoch:   number;
  updatedAtEpoch:   number;
}

export interface IToolManifestDB {
  create(manifest: IToolManifestRecord): Promise<void>;
  findByToolId(toolId: string): Promise<IToolManifestRecord | undefined>;
  findById(id: string): Promise<IToolManifestRecord | undefined>;
  listActive(chainId?: number): Promise<IToolManifestRecord[]>;
  deactivate(toolId: string): Promise<void>;

  /**
   * Keyword search across name, description, protocolName, and tags (ILIKE).
   * Results ordered by priority DESC, isDefault DESC.
   * Only returns isActive=true records.
   */
  search(
    query: string,
    options: { limit: number; category?: string; chainId?: number },
  ): Promise<IToolManifestRecord[]>;
}
```

### 2c. Rewrite `DrizzleToolManifestRepo` — `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repo.ts`

Implement the new `IToolManifestDB`. The `search()` method builds a Drizzle query with:
- `ilike(name, query)` OR `ilike(description, query)` OR `ilike(protocolName, query)` OR `ilike(tags, query)` — the last one catches tag keywords since tags is stored as a JSON string
- `eq(isActive, true)`
- Optional `eq(category, options.category)` if provided
- Optional `ilike(chainIds, '%' + options.chainId + '%')` for chain filtering
- `orderBy(desc(priority), desc(isDefault))`
- `limit(options.limit)`

Follow the pattern of `DrizzleTokenRegistryRepo.searchBySymbol` (uses `ilike` + `or` from drizzle-orm).

---

## File change inventory — Part 1

| File | Action |
|---|---|
| `src/helpers/enums/toolCategory.enum.ts` | **Create** |
| `src/use-cases/interface/output/toolManifest.types.ts` | **Create** (Zod schemas + `deserializeManifest`) |
| `src/use-cases/interface/output/intentParser.interface.ts` | Widen `action` to `string`, add `params?`, add `relevantManifests?` to `IIntentParser.parse()` |
| `src/use-cases/interface/output/repository/toolManifest.repo.ts` | Rewrite: `IToolManifest` → `IToolManifestRecord`, add `search()` to `IToolManifestDB` |
| `src/adapters/implementations/output/sqlDB/schema.ts` | Replace `toolManifests` table |
| `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repo.ts` | Rewrite to match new schema + implement `search()` |
| `src/adapters/implementations/output/intentParser/openai.intentParser.ts` | Accept (and ignore) `_relevantManifests?` param — signature compliance only |
| `drizzle/` | New migration file (auto-generated) |

## What does NOT change in this part

- All solver files
- `IntentUseCaseImpl`
- `intent.validator.ts`
- `solverRegistry.ts` / `solverRegistry.interface.ts`
- `HttpApiServer`
- `assistant.di.ts`
- All Telegram adapters, blockchain adapters, auth
