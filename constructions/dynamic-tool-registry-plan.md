# Dynamic Tool Registry — Implementation Plan

> Status: Planning  
> Scope: Allow third-party developers to register tools (solvers) via HTTP API. Each registered tool is stored in DB and executed by a manifest-driven solver engine at runtime. All existing Telegram-facing behavior is preserved unchanged.

---

## Overview of changes

```
New                   Changed                   Untouched
────────────────────  ────────────────────────  ─────────────────────────────
TOOL_CATEGORY enum    tool_manifests (DB schema) Telegram handler
ToolStep Zod schemas  IToolManifest (repo iface) TelegramAssistantHandler
ManifestDrivenSolver  IToolManifestDB methods    IntentUseCaseImpl
POST /tools handler   SolverRegistry             auth / assistant use cases
GET  /tools handler   IntentPackage (action type) TokenRegistry / crawler
                      intent.validator.ts         All blockchain adapters
                      intentAction.enum.ts        All existing solvers
                      assistant.di.ts
```

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

This is separate from `SOLVER_TYPE` and separate from `INTENT_ACTION`. It classifies the *kind of execution* the tool performs and drives which security policies apply (whitelist check, quote expiry, etc.).

### 1b. New file `src/use-cases/interface/output/toolManifest.types.ts`

Define the discriminated-union step schema with Zod and export domain types:

```typescript
import { z } from "zod";
import { TOOL_CATEGORY } from "../../helpers/enums/toolCategory.enum";

// ── Step kinds ──────────────────────────────────────────────────────────────

export const HttpGetStepSchema = z.object({
  kind:    z.literal("http_get"),
  name:    z.string(),
  url:     z.string(),          // supports {{intent.*}} and {{steps.<name>.*}} templates
  extract: z.record(z.string()), // JSONPath-like: { "calldata": "$.tx.data" }
});

export const HttpPostStepSchema = z.object({
  kind:    z.literal("http_post"),
  name:    z.string(),
  url:     z.string(),
  body:    z.record(z.unknown()), // template values allowed in leaf strings
  extract: z.record(z.string()),
});

export const AbiEncodeStepSchema = z.object({
  kind:            z.literal("abi_encode"),
  name:            z.string(),
  contractAddress: z.string(),  // must be a valid 0x address (validated at registration)
  abiFragment: z.object({
    name:   z.string(),
    inputs: z.array(z.object({ name: z.string(), type: z.string() })),
  }),
  paramMapping: z.record(z.string()), // maps ABI param name → template string
});

export const CalldataPassthroughStepSchema = z.object({
  kind:  z.literal("calldata_passthrough"),
  name:  z.string(),
  to:    z.string(),   // template string
  data:  z.string(),   // template string
  value: z.string().optional().default("0"),
});

export const Erc20TransferStepSchema = z.object({
  kind: z.literal("erc20_transfer"),
  name: z.string(),
  // No extra config — params always come from intent.fromToken, intent.recipient, intent.amountRaw
});

export const ToolStepSchema = z.discriminatedUnion("kind", [
  HttpGetStepSchema,
  HttpPostStepSchema,
  AbiEncodeStepSchema,
  CalldataPassthroughStepSchema,
  Erc20TransferStepSchema,
]);

export type ToolStep = z.infer<typeof ToolStepSchema>;

// ── Manifest ─────────────────────────────────────────────────────────────────

export const ToolManifestSchema = z.object({
  toolId:      z.string().min(3).max(64).regex(/^[a-z0-9-]+$/), // slug
  category:    z.nativeEnum(TOOL_CATEGORY),
  name:        z.string().min(1).max(100),
  description: z.string().min(10).max(500),
  inputSchema: z.record(z.unknown()), // raw JSON Schema — passed to Claude tool_use as-is
  steps:       z.array(ToolStepSchema).min(1),
  preflightPreview: z.object({
    label:         z.string(),
    valueTemplate: z.string(), // e.g. "{{steps.fetchQuote.amountOut}}"
  }).optional(),
  revenueWallet: z.string().optional(), // contributor 0x address
  chainIds:      z.array(z.number()).min(1),
});

export type ToolManifest = z.infer<typeof ToolManifestSchema>;
```

**Why `inputSchema` is `record(unknown)` not typed**: it is raw JSON Schema that gets passed verbatim to Claude's tool_use definitions. Typing its internals would be over-engineering.

### 1c. Update `INTENT_ACTION` enum

Add nothing to the enum itself. Instead, change the *type* of `action` in `IntentPackage` to `string` (widening from the enum). The enum values remain as the set of well-known built-in actions. Dynamic tools set `action` to their `toolId` string (e.g. `"aave-supply"`).

```typescript
// src/helpers/enums/intentAction.enum.ts — no change to enum values

// src/use-cases/interface/output/intentParser.interface.ts
export interface IntentPackage {
  action:           string;          // INTENT_ACTION value OR dynamic toolId
  fromTokenSymbol?: string;
  toTokenSymbol?:   string;
  amountHuman?:     string;
  slippageBps?:     number;
  recipient?:       Address;
  params?:          Record<string, unknown>; // ADD: extra fields for dynamic tools
  confidence:       number;
  rawInput:         string;
}
```

The new `params` field is where LLM-extracted values for dynamic tool inputs land (e.g. `params.poolId`, `params.lockDuration`). Built-in actions never use it.

**Important**: The `INTENT_ACTION` enum is NOT removed. It is used for type-narrowing in the validator, the use case, and the pre-flight summary. It just no longer exhausts all possible values of `action`.

---

## Step 2 — DB migration

### 2a. Update `schema.ts`

Replace the existing `toolManifests` table definition entirely:

```typescript
export const toolManifests = pgTable("tool_manifests", {
  id:               uuid("id").primaryKey(),
  toolId:           text("tool_id").notNull().unique(),   // slug, external key
  category:         text("category").notNull(),            // TOOL_CATEGORY
  name:             text("name").notNull(),
  description:      text("description").notNull(),
  inputSchema:      text("input_schema").notNull(),        // JSON string of JSON Schema
  steps:            text("steps").notNull(),               // JSON string of ToolStep[]
  preflightPreview: text("preflight_preview"),             // JSON string or null
  revenueWallet:    text("revenue_wallet"),
  isVerified:       boolean("is_verified").notNull().default(false),
  isActive:         boolean("is_active").notNull().default(true),
  chainIds:         text("chain_ids").notNull(),           // JSON string of number[]
  createdAtEpoch:   integer("created_at_epoch").notNull(),
  updatedAtEpoch:   integer("updated_at_epoch").notNull(),
});
```

Removed columns vs current: `display_name`, `version`, `solver_type`, `endpoint_url`, `output_schema`, `rev_share_bps` (replaced by `revenue_wallet`).
Added columns: `tool_id`, `category`, `steps`, `preflight_preview`, `revenue_wallet`, `is_verified`.

Run `npm run db:generate && npm run db:migrate`.

### 2b. Update `IToolManifest` domain type and `IToolManifestDB` interface

```typescript
// src/use-cases/interface/output/repository/toolManifest.repo.ts

import type { ToolManifest } from "../toolManifest.types";

export interface IToolManifestRecord {
  id:               string;
  toolId:           string;
  category:         string;
  name:             string;
  description:      string;
  inputSchema:      string;   // raw JSON string
  steps:            string;   // raw JSON string
  preflightPreview: string | null;
  revenueWallet:    string | null;
  isVerified:       boolean;
  isActive:         boolean;
  chainIds:         string;   // raw JSON string
  createdAtEpoch:   number;
  updatedAtEpoch:   number;
}

export interface IToolManifestDB {
  create(manifest: IToolManifestRecord): Promise<void>;
  findByToolId(toolId: string): Promise<IToolManifestRecord | undefined>;
  findById(id: string): Promise<IToolManifestRecord | undefined>;
  listActive(chainId?: number): Promise<IToolManifestRecord[]>;
  deactivate(toolId: string): Promise<void>;
}
```

Note: `IToolManifestRecord` stores JSON strings (not parsed objects) because Drizzle uses `text` columns for JSONB-like data in this codebase (consistent with existing `parsedJson`, `inputSchema`, `outputSchema` patterns). Parsing happens at the service/use-case layer.

### 2c. Update `DrizzleToolManifestRepo`

Rewrite `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repo.ts` to implement the new `IToolManifestDB` against the updated Drizzle schema. Straightforward CRUD — follow the pattern of other repos in the directory.

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
constructor(
  private readonly toolManifestDB: IToolManifestDB,
)

register(manifest):
  1. Validate manifest with ToolManifestSchema (Zod) → throws ZodError on failure
  2. Check toolId uniqueness — findByToolId → throw "TOOL_ID_TAKEN" if exists
  3. For each step of kind "abi_encode": validate contractAddress is valid 0x address
  4. Serialize inputSchema, steps, preflightPreview, chainIds to JSON strings
  5. Write to DB via toolManifestDB.create()
  6. Return { toolId, id, createdAt }

list(chainId):
  1. toolManifestDB.listActive(chainId)
  2. Deserialize each record: parse inputSchema, steps, preflightPreview, chainIds
  3. Return array of ToolManifest
```

**Guardrail: contract address whitelist (for `abi_encode` steps)**

On registration, for each `abi_encode` step, the `contractAddress` must be a valid checksummed Ethereum address (`isAddress()` from viem). Platform operators can extend this to a full whitelist — but at minimum, reject garbage values early. Log a warning if the contract is not in a known-good set.

---

## Step 4 — Manifest-Driven Solver Engine

### 4a. Template engine helper `src/adapters/implementations/output/solver/manifestSolver/templateEngine.ts`

Resolves `{{path.to.value}}` inside strings using a context object:

```
type TemplateContext = {
  intent: IntentPackage & { params?: Record<string, unknown> };
  user:   { scaAddress: string };
  steps:  Record<string, Record<string, string>>; // accumulated step outputs
}

function resolve(template: string, ctx: TemplateContext): string
function resolveRecord(obj: Record<string, string>, ctx: TemplateContext): Record<string, string>
```

Implementation: regex replace `{{x.y.z}}` → nested property lookup on `ctx`. Throw `TemplateResolutionError` with the missing path if a variable is not found.

### 4b. Step executors `src/adapters/implementations/output/solver/manifestSolver/stepExecutors.ts`

One function per step kind, all with the same signature:

```typescript
type StepExecutor = (step: ToolStep, ctx: TemplateContext) => Promise<Record<string, string>>;
```

- **`executeHttpGet`**: resolve URL template → `fetch(url)` → apply `extract` JSONPath mappings to response JSON
- **`executeHttpPost`**: resolve URL + body templates → `fetch(url, { method: "POST", body })` → extract
- **`executeAbiEncode`**: resolve paramMapping templates → `encodeFunctionData()` from viem → return `{ to, data, value: "0" }`
- **`executeCalldataPassthrough`**: resolve `to`, `data`, `value` templates → return as-is
- **`executeErc20Transfer`**: encode `transfer(address,uint256)` using `intent.recipient` and `intent.amountRaw` → return `{ to: tokenAddress, data, value: "0" }`

JSONPath extraction (`$.a.b.c`) — implement a minimal path resolver (no dependency needed for simple dot-notation paths). Support at least `$.field` and `$.nested.field`.

### 4c. New solver `src/adapters/implementations/output/solver/manifestSolver/manifestDriven.solver.ts`

```typescript
export class ManifestDrivenSolver implements ISolver {
  readonly name: string;

  constructor(private readonly manifest: ToolManifest) {
    this.name = manifest.toolId;
  }

  async buildCalldata(
    intent: IntentPackage,
    userAddress: string,
  ): Promise<{ to: string; data: string; value: string }> {
    const ctx: TemplateContext = {
      intent,
      user: { scaAddress: userAddress },
      steps: {},
    };

    let lastOutput: Record<string, string> = {};

    for (const step of this.manifest.steps) {
      const executor = STEP_EXECUTORS[step.kind];
      const output = await executor(step, ctx);
      ctx.steps[step.name] = output;
      lastOutput = output;
    }

    // Final step must produce { to, data, value }
    if (!lastOutput.to || !lastOutput.data) {
      throw new Error(`ManifestDrivenSolver(${this.name}): last step did not produce 'to' and 'data'`);
    }

    return {
      to:    lastOutput.to,
      data:  lastOutput.data,
      value: lastOutput.value ?? "0",
    };
  }
}
```

---

## Step 5 — Update SolverRegistry

`src/adapters/implementations/output/solver/solverRegistry.ts` currently maps `string → ISolver` in a static in-memory map.

Add a DB fallback path:

```typescript
export class SolverRegistry implements ISolverRegistry {
  private readonly hardcoded: Map<string, ISolver>;

  constructor(
    solvers: ISolver[],
    private readonly toolManifestDB: IToolManifestDB,  // ADD
  ) {
    this.hardcoded = new Map(solvers.map(s => [s.name, s]));
  }

  async getSolverAsync(action: string): Promise<ISolver | undefined> {
    // 1. Try hardcoded first (builtin actions: swap, transfer, stake, etc.)
    const hardcoded = this.hardcoded.get(action);
    if (hardcoded) return hardcoded;

    // 2. Fall back to DB — treat action string as toolId
    const record = await this.toolManifestDB.findByToolId(action);
    if (!record || !record.isActive) return undefined;

    const manifest = deserializeManifest(record);  // parse JSON columns
    return new ManifestDrivenSolver(manifest);
  }
}
```

**Note**: The existing `getSolver(action)` on `ISolverRegistry` is synchronous. It must be changed to `getSolverAsync(action): Promise<ISolver | undefined>`. This requires updating `IntentUseCaseImpl` to `await` the solver lookup (steps 4 and 11 in the intent flow). Everything else stays the same.

Update `ISolverRegistry` interface accordingly.

---

## Step 6 — Update Intent Validator

`intent.validator.ts` currently has a static `REQUIRED_FIELDS` map keyed by `INTENT_ACTION`.

Changes needed:
1. `validateIntent` gains an optional `manifest?: ToolManifest` parameter
2. When `manifest` is provided (dynamic tool), derive required fields from `manifest.inputSchema.required`
3. When `manifest` is absent (builtin action), use existing `REQUIRED_FIELDS` as before

```typescript
export function validateIntent(
  intent: IntentPackage,
  messageCount: number,
  manifest?: ToolManifest,   // ADD
): void {
  const atLimit = messageCount >= WINDOW_SIZE;

  let required: string[];
  if (manifest) {
    // Dynamic tool: required fields come from JSON Schema
    const schema = manifest.inputSchema as { required?: string[] };
    required = schema.required ?? [];
  } else {
    // Builtin action: static map (existing behavior, unchanged)
    required = (REQUIRED_FIELDS[intent.action as INTENT_ACTION] ?? []) as string[];
  }

  const missingFields = required.filter((field) => {
    // Check both top-level IntentPackage fields and intent.params
    const val = (intent as Record<string, unknown>)[field] ?? intent.params?.[field];
    return val == null;
  });

  // ... rest of validation unchanged ...
}
```

The existing error classes (`MissingFieldsError`, `InvalidFieldError`, `ConversationLimitError`) are not changed.

### Update `IntentUseCaseImpl.parseAndExecute`

Before calling `validateIntent`, check if the action is a dynamic tool and fetch the manifest:

```typescript
// After intent = await this.intentParser.parse(...)
let manifest: ToolManifest | undefined;
if (intent !== null && !Object.values(INTENT_ACTION).includes(intent.action as INTENT_ACTION)) {
  const record = await this.toolManifestDB.findByToolId(intent.action);
  manifest = record ? deserializeManifest(record) : undefined;
}
if (intent !== null) validateIntent(intent, messages.length, manifest);
```

---

## Step 7 — HTTP API endpoints

Add two new routes to `HttpApiServer`:

### `POST /tools` — register a tool

**No auth required for initial implementation** (open registration). Can add JWT auth later.

Request body: `ToolManifest` (see Step 1b schema)

```
Validation:
  1. Parse body as JSON
  2. ToolManifestSchema.safeParse(body) → 400 on failure with Zod error details
  3. Delegate to IToolRegistrationUseCase.register()
  4. On "TOOL_ID_TAKEN" → 409 { error: "Tool ID already registered" }
  5. On success → 201 { toolId, id, createdAt }
```

### `GET /tools` — list active tools

Query param: `chainId` (optional, integer)

```
1. Delegate to IToolRegistrationUseCase.list(chainId)
2. Return 200 { tools: ToolManifest[] }
```

Add both routes to the `handle()` switch in `HttpApiServer`. Inject `IToolRegistrationUseCase` as a new optional constructor parameter (consistent with how `intentUseCase` is injected).

---

## Step 8 — DI wiring in `assistant.di.ts`

```
1. DrizzleToolManifestRepo → already property on DrizzleSqlDB (update impl in Step 2c)
2. ToolRegistrationUseCaseImpl → new, takes sqlDB.toolManifests
3. SolverRegistry → pass sqlDB.toolManifests as second arg (Step 5)
4. IntentUseCaseImpl → pass sqlDB.toolManifests for dynamic manifest fetch (Step 6)
5. HttpApiServer → pass toolRegistrationUseCase as new constructor arg
```

No other DI changes.

---

## Step 9 — LLM prompt update for dynamic tools

The `AnthropicIntentParser` needs to know about registered tools so the LLM can route to them. Currently it has a hardcoded system prompt listing known actions.

On each `parse()` call, fetch active tool manifests and append them to the system prompt as a tool list:

```
// In AnthropicIntentParser.parse()
const dynamicTools = await this.toolManifestDB.listActive(this.chainId);
const toolDescriptions = dynamicTools.map(t =>
  `- toolId: "${t.toolId}" | ${t.name}: ${t.description}`
).join("\n");

// Append to system prompt:
// "Additionally, the following community tools are available. Set action = toolId to use them:\n" + toolDescriptions
```

When action = a dynamic toolId, the LLM must populate `params` with values matching the tool's `inputSchema`. Include the inputSchema in the prompt for tools relevant to the user's request.

`IIntentParser` needs `toolManifestDB` injected.

---

## Step 10 — Migration for existing data

Run `db:generate` after schema.ts change. The generated migration will drop/alter `tool_manifests`. Since the existing table has no production data (all solvers are hardcoded), this is a clean drop-and-recreate.

---

## Guardrails summary

| Risk | Guardrail |
|---|---|
| Malformed step config stored in DB | Zod ToolManifestSchema validation at `POST /tools` |
| Malicious `contractAddress` in abi_encode | `isAddress()` validation at registration |
| Template injection via user-controlled input | Templates only resolve from typed context fields; no `eval` or `Function()` |
| Infinite loops in step pipeline | Steps array is fixed at registration time; no dynamic branching |
| Stale quote executed on `/confirm` | (Future) Add `quoteExpiresAt` to solver output; re-run quote step if expired |
| Dynamic solver returning wrong `to` address | Pre-flight simulator validates the full UserOp; simulation failure = abort |
| toolId collision with INTENT_ACTION values | Validate at registration: reject toolIds that collide with `Object.values(INTENT_ACTION)` |
| Broken DB fallback crashing intent flow | `getSolverAsync` catches DB errors and returns `undefined`; existing "no solver" rejection path handles it |

---

## File change inventory

| File | Action |
|---|---|
| `src/helpers/enums/toolCategory.enum.ts` | **Create** |
| `src/use-cases/interface/output/toolManifest.types.ts` | **Create** |
| `src/use-cases/interface/input/toolRegistration.interface.ts` | **Create** |
| `src/use-cases/implementations/toolRegistration.usecase.ts` | **Create** |
| `src/adapters/implementations/output/solver/manifestSolver/templateEngine.ts` | **Create** |
| `src/adapters/implementations/output/solver/manifestSolver/stepExecutors.ts` | **Create** |
| `src/adapters/implementations/output/solver/manifestSolver/manifestDriven.solver.ts` | **Create** |
| `src/helpers/enums/intentAction.enum.ts` | No change to enum values |
| `src/use-cases/interface/output/intentParser.interface.ts` | Widen `action` to `string`, add `params?` field |
| `src/use-cases/interface/output/repository/toolManifest.repo.ts` | Rewrite `IToolManifest` → `IToolManifestRecord`, update `IToolManifestDB` |
| `src/use-cases/interface/output/solver/solverRegistry.interface.ts` | `getSolver` → `getSolverAsync` |
| `src/adapters/implementations/output/sqlDB/schema.ts` | Replace `toolManifests` table definition |
| `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repo.ts` | Rewrite to match new schema |
| `src/adapters/implementations/output/solver/solverRegistry.ts` | Add DB fallback, make async |
| `src/adapters/implementations/output/intentParser/anthropic.intentParser.ts` | Inject `IToolManifestDB`, append dynamic tools to prompt |
| `src/adapters/implementations/output/intentParser/intent.validator.ts` | Add `manifest?` param, dynamic required fields |
| `src/use-cases/implementations/intent.usecase.ts` | Await `getSolverAsync`, fetch manifest for dynamic validate |
| `src/adapters/implementations/input/http/httpServer.ts` | Add `POST /tools`, `GET /tools` routes |
| `src/adapters/inject/assistant.di.ts` | Wire new deps |
| `drizzle/` | New migration file (auto-generated) |

---

## What does NOT change

- `TelegramAssistantHandler` — zero changes
- `TelegramBot` — zero changes
- `AssistantUseCaseImpl` — zero changes
- `AuthUseCaseImpl` — zero changes
- `ClaimRewardsSolver`, `TraderJoeSolver` — zero changes (hardcoded path still works)
- All blockchain adapters (`viemClient`, `smartAccount`, `sessionKey`, `paymaster`, `userOpBuilder`) — zero changes
- `RpcSimulator` — zero changes
- `TokenRegistry` / `TokenCrawlerJob` — zero changes
- Existing Telegram commands (`/confirm`, `/cancel`, `/portfolio`, `/wallet`) — zero changes
- HTTP routes `/auth/*`, `/intent/:id`, `/portfolio`, `/tokens` — zero changes
