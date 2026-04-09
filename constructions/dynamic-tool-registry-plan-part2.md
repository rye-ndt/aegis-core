# Dynamic Tool Registry — Part 2: Solver Engine & Tool Registration

> **Stage**: 2 of 3  
> **Prerequisite**: Part 1 must be complete and compiling — all types, interfaces, Zod schemas, and the updated DB schema must exist.  
> **Constraint**: This part adds **execution logic only** — the manifest-driven solver engine, the tool registration use case, the async solver registry, and the intent validator update. The discovery pipeline (wiring into `IntentUseCaseImpl`) and the HTTP API are NOT implemented here. After this part, tools can be registered into the DB and executed by `ManifestDrivenSolver`, but the intent flow still uses hardcoded solvers.

---

## Scope

| Creates | Modifies |
|---|---|
| `templateEngine.ts` | `solverRegistry.interface.ts` (`getSolver` → `getSolverAsync`) |
| `stepExecutors.ts` | `solverRegistry.ts` (add DB fallback, async) |
| `manifestDriven.solver.ts` | `intent.validator.ts` (add `manifest?` param) |
| `toolRegistration.interface.ts` | |
| `toolRegistration.usecase.ts` | |

**Do not touch** `IntentUseCaseImpl`, `AnthropicIntentParser`, `HttpApiServer`, or `assistant.di.ts` in this part.

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

`getSolver` is currently synchronous. It must become `getSolverAsync` to support the DB fallback. This requires updating the interface and the single call site in `IntentUseCaseImpl` (that wiring happens in Part 3, but the interface and implementation change here).

### 5a. Interface `src/use-cases/interface/output/solver/solverRegistry.interface.ts`

```typescript
export interface ISolverRegistry {
  getSolverAsync(action: string): Promise<ISolver | undefined>;
  register(action: string, solver: ISolver): void;
}
```

Remove `getSolver` (the synchronous version). No other methods change.

### 5b. Concrete implementation `src/adapters/implementations/output/solver/solverRegistry.ts`

```typescript
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

Note: `IntentUseCaseImpl` still calls the old `getSolver()` at this point — that call site is updated in Part 3. The interface change here will cause a compile error in `IntentUseCaseImpl` until Part 3 is done. Address this by temporarily leaving the old `getSolver` as a deprecated alias in the concrete class only (not the interface), or accept that Part 3 must follow immediately.

---

## Step 6 — Update Intent Validator

`intent.validator.ts` gains an optional `manifest?: ToolManifest` parameter. When present, required fields come from `manifest.inputSchema.required`; when absent, existing `REQUIRED_FIELDS` map applies unchanged. Existing error classes are not changed.

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

  // ... rest of validation unchanged (MissingFieldsError, ConversationLimitError, address/amount checks) ...
}
```

---

## File change inventory — Part 2

| File | Action |
|---|---|
| `src/use-cases/interface/input/toolRegistration.interface.ts` | **Create** |
| `src/use-cases/implementations/toolRegistration.usecase.ts` | **Create** |
| `src/adapters/implementations/output/solver/manifestSolver/templateEngine.ts` | **Create** |
| `src/adapters/implementations/output/solver/manifestSolver/stepExecutors.ts` | **Create** |
| `src/adapters/implementations/output/solver/manifestSolver/manifestDriven.solver.ts` | **Create** |
| `src/use-cases/interface/output/solver/solverRegistry.interface.ts` | `getSolver` → `getSolverAsync` (async) |
| `src/adapters/implementations/output/solver/solverRegistry.ts` | Add `IToolManifestDB` constructor param, implement `getSolverAsync` with DB fallback |
| `src/adapters/implementations/output/intentParser/intent.validator.ts` | Add `manifest?: ToolManifest` param; dynamic required-field check |

## What does NOT change in this part

- `IntentUseCaseImpl` — discovery wiring is Part 3
- `AnthropicIntentParser` — Part 3
- `HttpApiServer` — Part 3
- `assistant.di.ts` — Part 3
- `ClaimRewardsSolver`, `TraderJoeSolver` — zero changes throughout
- All Telegram adapters, blockchain adapters, auth
