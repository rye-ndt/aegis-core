# Dynamic Tool Registry — Implementation Plan (v2)

> Status: Planning  
> Scope: Allow third-party developers to register tools (solvers) via HTTP API. Each registered tool is stored in DB and executed by a manifest-driven solver engine at runtime. All existing Telegram-facing behavior is preserved unchanged.
>
> **v2 additions**: Hierarchical Discovery Layer (3-tier filtering), conflict resolution via `isDefault`/`protocolName`, and a hexagonal-clean tool selection pipeline where `IntentUseCaseImpl` owns discovery and passes manifests to the intent parser rather than the parser reaching into the DB directly.
>
> ---
>
> ## Implementation Stages
>
> This plan is split into 3 self-contained parts to be implemented sequentially:
>
> | Part | File | Scope |
> |---|---|---|
> | **1** | [dynamic-tool-registry-plan-part1.md](dynamic-tool-registry-plan-part1.md) | Type system & DB foundation — enums, Zod schemas, interfaces, DB schema migration. No logic. |
> | **2** | [dynamic-tool-registry-plan-part2.md](dynamic-tool-registry-plan-part2.md) | Solver engine & tool registration — template engine, step executors, manifest-driven solver, async registry, validator update. |
> | **3** | [dynamic-tool-registry-plan-part3.md](dynamic-tool-registry-plan-part3.md) | Discovery pipeline & integration — `IntentUseCaseImpl` wiring, `AnthropicIntentParser`, HTTP API, DI composition. |
>
> Each part file is self-contained with its own file change inventory and "do not touch" constraints.
>
> ---

---

## Overview of changes

```
New                        Changed                        Untouched
─────────────────────────  ─────────────────────────────  ─────────────────────────────────
TOOL_CATEGORY enum         tool_manifests (DB schema)     TelegramAssistantHandler
ToolStep Zod schemas       IToolManifest → IToolManifestRecord  TelegramBot
ToolManifest Zod schema    IToolManifestDB methods (+search)    AssistantUseCaseImpl
ManifestDrivenSolver       ISolverRegistry (async)        AuthUseCaseImpl
deserializeManifest()      IIntentParser.parse() sig      TokenRegistry / crawler
POST /tools handler        IntentPackage (action, params) All blockchain adapters
GET /tools handler         IntentUseCaseImpl (discovery)  All existing solvers
                           intent.validator.ts            OpenAIIntentParser
                           intentAction.enum.ts           toolRegistry.concrete.ts
                           assistant.di.ts
```

---

## Architecture of the Hierarchical Discovery Layer

The "Too Many Tools" problem is solved with a **pull-based discovery pipeline**. Rather than injecting all tool manifests into every LLM prompt, `IntentUseCaseImpl` runs a fast DB search and resolves conflicts *before* calling the parser. The parser receives only the 5–8 most relevant manifests as a parameter.

```
User message arrives at IntentUseCaseImpl.parseAndExecute()
          │
          ▼
  Step A — toolManifestDB.search(rawInput, { limit: 15, chainId })
           ILIKE on: name, description, tags, protocolName
           Order by: priority DESC, isDefault DESC
          │
          ▼
  Step B — resolveConflicts(candidates, rawInput)
           For each TOOL_CATEGORY bucket:
             if user named a protocol → keep the protocolName match
             else if multiple hits    → keep the isDefault=true one (or highest priority)
           Cap final set at 8 tools
          │
          ▼
  Step C — deserializeManifest(record) × N → ToolManifest[]
          │
          ▼
  Step D — intentParser.parse(messages, userId, relevantManifests)
           Parser builds Anthropic tool_use definitions from the injected list only
           LLM picks one; populates intent.action = toolId + intent.params
```

**Hexagonal compliance**: `IntentUseCaseImpl` is application-core. It calls output port `IToolManifestDB` (a dependency it already has). The `AnthropicIntentParser` adapter receives manifests as a parameter — it never holds a DB reference. No adapter calls another adapter.

---

## 3-Layer categorization model

| Layer | Field | Controls |
|---|---|---|
| **Technical intent** | `category` (TOOL_CATEGORY) | Execution security policy (whitelist check, quote expiry) |
| **Functional domain** | `tags` (`string[]`) | Search space filtering ("yield" → lending + staking) |
| **Protocol identity** | `protocolName` | Conflict resolution override ("on Trader Joe" → pick TraderJoe tool) |

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

### 1c. Update `INTENT_ACTION` enum

Add nothing to the enum values. Change the *type* of `action` in `IntentPackage` to `string` (widening). Dynamic tools set `action` to their `toolId` (e.g. `"aave-supply"`). Add `params?` for LLM-extracted dynamic tool inputs.

```typescript
// src/use-cases/interface/output/intentParser.interface.ts

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

`INTENT_ACTION` enum is NOT removed. It remains the narrowing tool in validator and use case. It just no longer exhausts all possible values of `action`.

### 1d. Update `IIntentParser` signature

Add `relevantManifests` as an optional third parameter. This is the hexagonal-clean way to pass tool discovery results from the use case to the adapter:

```typescript
// src/use-cases/interface/output/intentParser.interface.ts

import type { ToolManifest } from "./toolManifest.types";

export interface IIntentParser {
  parse(
    messages: string[],
    userId: string,
    relevantManifests?: ToolManifest[],   // ADD — injected by IntentUseCaseImpl
  ): Promise<IntentPackage | null>;
}
```

`OpenAIIntentParser.parse()` accepts the extra param and ignores it (no-op). It is the existing legacy parser; its behavior is unchanged.

---

## Step 2 — DB migration

### 2a. Update `schema.ts`

Replace the existing `toolManifests` table definition entirely:

```typescript
export const toolManifests = pgTable("tool_manifests", {
  id:               uuid("id").primaryKey(),
  toolId:           text("tool_id").notNull().unique(),     // slug, external key
  category:         text("category").notNull(),              // TOOL_CATEGORY
  name:             text("name").notNull(),
  description:      text("description").notNull(),
  protocolName:     text("protocol_name").notNull(),         // e.g. "Trader Joe V2"
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

Columns removed vs. current: `display_name`, `version`, `solver_type`, `endpoint_url`, `output_schema`, `rev_share_bps`.  
Columns added: `tool_id`, `category`, `protocol_name`, `tags`, `priority`, `is_default`, `steps`, `preflight_preview`, `revenue_wallet`, `is_verified`.

Run `npm run db:generate && npm run db:migrate`.

### 2b. Rewrite `IToolManifest` and `IToolManifestDB`

```typescript
// src/use-cases/interface/output/repository/toolManifest.repo.ts

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

### 2c. Update `DrizzleToolManifestRepo`

Rewrite `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repo.ts` to implement the new `IToolManifestDB`.

The `search()` method builds a Drizzle query with:
- `ilike(name, query)` OR `ilike(description, query)` OR `ilike(protocolName, query)` OR `ilike(tags, query)` — the last one catches tag keywords since tags is stored as a JSON string
- `eq(isActive, true)`
- Optional `eq(category, options.category)` if provided
- Optional `ilike(chainIds, '%' + options.chainId + '%')` for chain filtering (consistent with the JSON string pattern used for `listActive`)
- `orderBy(desc(priority), desc(isDefault))`
- `limit(options.limit)`

Follow the patterns of `DrizzleTokenRegistryRepo.searchBySymbol` (uses `ilike` + `or` from drizzle-orm).

---

## Step 3 — Tool Registration Use Case

### 3a. New port interface `src/use-cases/interface/input/toolRegistration.interface.ts`

```typescript
import type { ToolManifest } from "../output/toolManifest.types";

export interface RegisterToolResult {
  toolId:    string;
  id:        string;
  createdAt: number;
}

export interface IToolRegistrationUseCase {
  register(manifest: ToolManifest): Promise<RegisterToolResult>;
  list(chainId?: number): Promise<ToolManifest[]>;
}
```

### 3b. New use case `src/use-cases/implementations/toolRegistration.usecase.ts`

```
constructor(toolManifestDB: IToolManifestDB)

register(manifest):
  1. Validate with ToolManifestSchema (Zod) → throws ZodError on failure
  2. Reject toolIds that collide with Object.values(INTENT_ACTION)
  3. findByToolId → throw "TOOL_ID_TAKEN" if exists
  4. For each step of kind "abi_encode": isAddress(contractAddress) must be true
  5. Serialize inputSchema, steps, preflightPreview, chainIds, tags to JSON strings
  6. toolManifestDB.create()
  7. Return { toolId, id, createdAt }

list(chainId):
  1. toolManifestDB.listActive(chainId)
  2. Deserialize each record via deserializeManifest()
  3. Return ToolManifest[]
```

---

## Step 4 — Manifest-Driven Solver Engine

### 4a. Template engine `src/adapters/implementations/output/solver/manifestSolver/templateEngine.ts`

```typescript
type TemplateContext = {
  intent: IntentPackage;
  user:   { scaAddress: string };
  steps:  Record<string, Record<string, string>>;
}

function resolve(template: string, ctx: TemplateContext): string
function resolveRecord(obj: Record<string, string>, ctx: TemplateContext): Record<string, string>
```

Regex-replaces `{{x.y.z}}` with nested property lookup on `ctx`. Throws `TemplateResolutionError` with the missing path. No `eval` or `Function()`.

### 4b. Step executors `src/adapters/implementations/output/solver/manifestSolver/stepExecutors.ts`

One function per step kind, all typed `(step: ToolStep, ctx: TemplateContext) => Promise<Record<string, string>>`:

- **`executeHttpGet`**: resolve URL template → `fetch(url)` → apply `extract` JSONPath mappings
- **`executeHttpPost`**: resolve URL + body → `fetch(url, { method: "POST", body })` → extract
- **`executeAbiEncode`**: resolve paramMapping → `encodeFunctionData()` from viem → `{ to, data, value: "0" }`
- **`executeCalldataPassthrough`**: resolve `to`, `data`, `value` templates → return as-is
- **`executeErc20Transfer`**: encode `transfer(address,uint256)` using `intent.recipient` + `intent.amountRaw` → `{ to: tokenAddress, data, value: "0" }`

Minimal JSONPath resolver for `$.field` and `$.nested.field` — no dependency needed.

### 4c. Manifest-driven solver `src/adapters/implementations/output/solver/manifestSolver/manifestDriven.solver.ts`

```typescript
export class ManifestDrivenSolver implements ISolver {
  readonly name: string;

  constructor(private readonly manifest: ToolManifest) {
    this.name = manifest.toolId;
  }

  async buildCalldata(intent: IntentPackage, userAddress: string) {
    const ctx: TemplateContext = { intent, user: { scaAddress: userAddress }, steps: {} };
    let lastOutput: Record<string, string> = {};

    for (const step of this.manifest.steps) {
      const output = await STEP_EXECUTORS[step.kind](step, ctx);
      ctx.steps[step.name] = output;
      lastOutput = output;
    }

    if (!lastOutput.to || !lastOutput.data) {
      throw new Error(`ManifestDrivenSolver(${this.name}): last step must produce 'to' and 'data'`);
    }
    return { to: lastOutput.to, data: lastOutput.data, value: lastOutput.value ?? "0" };
  }
}
```

---

## Step 5 — Update SolverRegistry

`getSolver` is currently synchronous. It must become `getSolverAsync` to support the DB fallback. This requires updating the interface and the single call site in `IntentUseCaseImpl`.

```typescript
// ISolverRegistry interface change
export interface ISolverRegistry {
  getSolverAsync(action: string): Promise<ISolver | undefined>;
  register(action: string, solver: ISolver): void;
}

// SolverRegistry concrete implementation
export class SolverRegistry implements ISolverRegistry {
  private readonly hardcoded: Map<string, ISolver>;

  constructor(
    solvers: ISolver[],
    private readonly toolManifestDB: IToolManifestDB,
  ) {
    this.hardcoded = new Map(solvers.map(s => [s.name, s]));
  }

  async getSolverAsync(action: string): Promise<ISolver | undefined> {
    // 1. Hardcoded builtins first (swap, claim_rewards, etc.)
    const hardcoded = this.hardcoded.get(action);
    if (hardcoded) return hardcoded;

    // 2. DB fallback — treat action as toolId
    let record: IToolManifestRecord | undefined;
    try {
      record = await this.toolManifestDB.findByToolId(action);
    } catch {
      return undefined; // DB errors fall through to "no solver" path
    }
    if (!record || !record.isActive) return undefined;

    return new ManifestDrivenSolver(deserializeManifest(record));
  }

  register(action: string, solver: ISolver): void {
    this.hardcoded.set(action, solver);
  }
}
```

`IntentUseCaseImpl` updates `getSolver(intent.action)` → `await this.solverRegistry.getSolverAsync(intent.action)` in both `parseAndExecute` and `confirmAndExecute`.

---

## Step 6 — Update Intent Validator

`intent.validator.ts` gains an optional `manifest?: ToolManifest` parameter. When present, required fields come from `manifest.inputSchema.required`; when absent, existing `REQUIRED_FIELDS` map applies unchanged.

```typescript
export function validateIntent(
  intent: IntentPackage,
  messageCount: number,
  manifest?: ToolManifest,   // ADD
): void {
  const atLimit = messageCount >= WINDOW_SIZE;

  let required: string[];
  if (manifest) {
    // Dynamic tool: required fields from JSON Schema
    const schema = manifest.inputSchema as { required?: string[] };
    required = schema.required ?? [];
  } else {
    // Builtin action: static map (existing behavior, unchanged)
    required = (REQUIRED_FIELDS[intent.action as INTENT_ACTION] ?? []) as string[];
  }

  const missingFields = required.filter((field) => {
    const val = (intent as Record<string, unknown>)[field] ?? intent.params?.[field];
    return val == null;
  });

  // ... rest of validation unchanged ...
}
```

Existing error classes (`MissingFieldsError`, `InvalidFieldError`, `ConversationLimitError`) are not changed.

---

## Step 7 — Update `IntentUseCaseImpl` (discovery + async solver)

This is the central change for the hierarchical discovery layer. `IntentUseCaseImpl` gains `toolManifestDB: IToolManifestDB` as a new constructor parameter and two private methods.

### 7a. Constructor addition

```typescript
constructor(
  // ... existing params ...
  private readonly toolManifestDB: IToolManifestDB,  // ADD
  // ...
)
```

### 7b. `discoverRelevantTools` private method

```typescript
private async discoverRelevantTools(rawInput: string): Promise<ToolManifest[]> {
  const candidates = await this.toolManifestDB.search(rawInput, {
    limit: 15,
    chainId: this.chainId,
  });
  return this.resolveConflicts(candidates, rawInput);
}
```

### 7c. `resolveConflicts` private method

```typescript
private resolveConflicts(
  candidates: IToolManifestRecord[],
  rawInput: string,
): ToolManifest[] {
  // Group by category
  const byCategory = new Map<string, IToolManifestRecord[]>();
  for (const record of candidates) {
    const bucket = byCategory.get(record.category) ?? [];
    bucket.push(record);
    byCategory.set(record.category, bucket);
  }

  const resolved: IToolManifestRecord[] = [];
  const lowerInput = rawInput.toLowerCase();

  for (const [, bucket] of byCategory) {
    if (bucket.length === 1) {
      resolved.push(bucket[0]);
      continue;
    }
    // User explicitly named a protocol → use that tool
    const protocolMatch = bucket.find(
      (t) => lowerInput.includes(t.protocolName.toLowerCase()),
    );
    if (protocolMatch) {
      resolved.push(protocolMatch);
      continue;
    }
    // Multiple tools, no protocol specified → prefer isDefault, then highest priority
    // Bucket is already ordered by priority DESC, isDefault DESC from the DB query
    const winner = bucket.find((t) => t.isDefault) ?? bucket[0];
    if (winner) resolved.push(winner);
  }

  // Cap at 8 and deserialize
  return resolved.slice(0, 8).map(deserializeManifest);
}
```

### 7d. `parseAndExecute` wiring

```typescript
// Before calling intentParser.parse():
const relevantManifests = await this.discoverRelevantTools(params.rawInput);

// 2. Parse then validate intent
intent = await this.intentParser.parse(messages, params.userId, relevantManifests);

// Before validateIntent, check if action is a dynamic tool:
let manifest: ToolManifest | undefined;
if (intent !== null && !Object.values(INTENT_ACTION).includes(intent.action as INTENT_ACTION)) {
  manifest = relevantManifests.find((m) => m.toolId === intent.action);
}
if (intent !== null) validateIntent(intent, messages.length, manifest);
```

`confirmAndExecute` does **not** call `discoverRelevantTools` — the `IntentPackage` is already stored in DB with the resolved `action`. The only change there is `getSolver` → `getSolverAsync`.

---

## Step 8 — Create `AnthropicIntentParser`

Create `src/adapters/implementations/output/intentParser/anthropic.intentParser.ts`.

This adapter:
- Implements `IIntentParser`
- Constructor takes `apiKey: string` and `model: string` — **no `toolManifestDB`** (that was the v1 design; v2 moves discovery to the use case)
- `parse(messages, userId, relevantManifests?)` builds the Anthropic `messages` API call

Key logic for using `relevantManifests`:
```typescript
// Build tool_use definitions from injected manifests only
const toolDefinitions = (relevantManifests ?? []).map((t) => ({
  name: t.toolId,
  description: [
    `[${t.protocolName}] ${t.description}`,
    `Tags: ${t.tags.join(", ")}`,
    `Required inputs: ${Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).join(", ")}`,
  ].join(" | "),
  input_schema: t.inputSchema,
}));

// Append dynamic tool section to system prompt only if tools exist
const dynamicToolSection = toolDefinitions.length > 0
  ? `\nAdditionally, the following community tools are available. Set action = toolId to use them:\n`
    + toolDefinitions.map((t) => `- toolId: "${t.name}" | ${t.description}`).join("\n")
  : "";
```

The LLM output schema (Zod) must now accept `action: z.string()` (not `z.enum([...])`) to allow dynamic toolIds. Builtin actions remain in the enum description within the system prompt.

`params` field is added to the LLM response schema: `params: z.record(z.unknown()).nullable()`.

---

## Step 9 — HTTP API endpoints

Add two new routes to `HttpApiServer`:

### `POST /tools` — register a tool

No auth required for initial implementation. Request body: `ToolManifest`.

```
1. Parse body as JSON
2. ToolManifestSchema.safeParse(body) → 400 on failure with Zod error details
3. IToolRegistrationUseCase.register()
4. "TOOL_ID_TAKEN" → 409 { error: "Tool ID already registered" }
5. Success → 201 { toolId, id, createdAt }
```

### `GET /tools` — list active tools

Query param: `chainId` (optional, integer).

```
1. IToolRegistrationUseCase.list(chainId)
2. Return 200 { tools: ToolManifest[] }
```

Inject `IToolRegistrationUseCase` as a new optional constructor parameter on `HttpApiServer` (consistent with existing `intentUseCase` injection pattern).

---

## Step 10 — DI wiring in `assistant.di.ts`

```
1. DrizzleToolManifestRepo → updated impl (Step 2c), still a property on DrizzleSqlDB
2. ToolRegistrationUseCaseImpl → new, takes sqlDB.toolManifests
3. SolverRegistry → pass sqlDB.toolManifests as second arg (Step 5)
4. IntentUseCaseImpl → pass sqlDB.toolManifests as new constructor arg (Step 7)
5. AnthropicIntentParser → no toolManifestDB injection (step 8 design)
6. HttpApiServer → pass toolRegistrationUseCase as new constructor arg (Step 9)
```

No other DI changes.

---

## Step 11 — Migration for existing data

Run `db:generate` after schema.ts change. The existing `tool_manifests` table has no production data (all solvers are hardcoded), so the generated migration is a clean drop-and-recreate.

---

## Guardrails summary

| Risk | Guardrail |
|---|---|
| Malformed step config stored in DB | Zod ToolManifestSchema validation at `POST /tools` |
| Malicious `contractAddress` in abi_encode | `isAddress()` validation at registration |
| Template injection via user-controlled input | Templates resolve from typed context fields only; no `eval` or `Function()` |
| Infinite loops in step pipeline | Steps array is fixed at registration; no dynamic branching |
| Context window overflow from too many tools | Discovery caps at 8 manifests; only injected into the parser prompt |
| Multiple tools for same category confusing LLM | `resolveConflicts()` narrows to 1 per category before injection |
| Default tool misselected when protocol is named | `protocolName` substring match overrides `isDefault` |
| Stale quote executed on `/confirm` | (Future) `quoteExpiresAt` in solver output; re-run quote step if expired |
| Dynamic solver returning wrong `to` address | Pre-flight simulator validates full UserOp; simulation failure = abort |
| toolId collision with INTENT_ACTION values | Validated at registration: reject colliding slugs |
| DB error in discovery crashing intent flow | `discoverRelevantTools` lets the exception propagate — caller handles |
| DB error in getSolverAsync crashing confirm flow | Caught, returns `undefined`; existing "no solver" rejection path handles it |
| Hexagonal violation (adapter calling repo) | Fixed in v2: parser receives manifests as parameter; only use case calls IToolManifestDB |

---

## File change inventory

| File | Action |
|---|---|
| `src/helpers/enums/toolCategory.enum.ts` | **Create** |
| `src/use-cases/interface/output/toolManifest.types.ts` | **Create** (includes `deserializeManifest`) |
| `src/use-cases/interface/input/toolRegistration.interface.ts` | **Create** |
| `src/use-cases/implementations/toolRegistration.usecase.ts` | **Create** |
| `src/adapters/implementations/output/solver/manifestSolver/templateEngine.ts` | **Create** |
| `src/adapters/implementations/output/solver/manifestSolver/stepExecutors.ts` | **Create** |
| `src/adapters/implementations/output/solver/manifestSolver/manifestDriven.solver.ts` | **Create** |
| `src/adapters/implementations/output/intentParser/anthropic.intentParser.ts` | **Create** |
| `src/use-cases/interface/output/intentParser.interface.ts` | Widen `action` to `string`, add `params?`, add `relevantManifests?` to `IIntentParser.parse()` |
| `src/use-cases/interface/output/repository/toolManifest.repo.ts` | Rewrite: `IToolManifest` → `IToolManifestRecord`, update `IToolManifestDB` (+`search`) |
| `src/use-cases/interface/output/solver/solverRegistry.interface.ts` | `getSolver` → `getSolverAsync` |
| `src/adapters/implementations/output/sqlDB/schema.ts` | Replace `toolManifests` table (add `protocol_name`, `tags`, `priority`, `is_default`) |
| `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repo.ts` | Rewrite to match new schema + implement `search()` |
| `src/adapters/implementations/output/solver/solverRegistry.ts` | Add DB fallback, make `getSolverAsync` async, accept `IToolManifestDB` in constructor |
| `src/adapters/implementations/output/intentParser/intent.validator.ts` | Add `manifest?: ToolManifest` param, check dynamic required fields |
| `src/adapters/implementations/output/intentParser/openai.intentParser.ts` | Accept (and ignore) new `relevantManifests?` param in `parse()` — signature compliance only |
| `src/use-cases/implementations/intent.usecase.ts` | Add `toolManifestDB`, `discoverRelevantTools()`, `resolveConflicts()`, await `getSolverAsync`, pass manifests to parser, pass manifest to validator |
| `src/adapters/implementations/input/http/httpServer.ts` | Add `POST /tools`, `GET /tools` routes |
| `src/adapters/inject/assistant.di.ts` | Wire new deps |
| `drizzle/` | New migration file (auto-generated) |

---

## What does NOT change

- `TelegramAssistantHandler` — zero changes
- `TelegramBot` — zero changes
- `AssistantUseCaseImpl` — zero changes
- `AuthUseCaseImpl` — zero changes
- `TokenIngestionUseCase` — zero changes
- `ClaimRewardsSolver`, `TraderJoeSolver` — zero changes (hardcoded path still works; `getSolverAsync` checks hardcoded map first)
- All blockchain adapters (`viemClient`, `smartAccount`, `sessionKey`, `paymaster`, `userOpBuilder`) — zero changes
- `RpcSimulator` — zero changes
- `TokenRegistry` / `TokenCrawlerJob` — zero changes
- `toolRegistry.concrete.ts` (LLM tool registry for assistant tools) — zero changes
- All existing Telegram commands (`/confirm`, `/cancel`, `/portfolio`, `/wallet`) — zero changes
- HTTP routes `/auth/*`, `/intent/:id`, `/portfolio`, `/tokens` — zero changes
