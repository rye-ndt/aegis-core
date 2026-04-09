# Dynamic Tool Registry — Part 3: Discovery Pipeline & Integration

> **Stage**: 3 of 3  
> **Prerequisite**: Part 1 and Part 2 must be complete and compiling — all types, interfaces, solver engine, tool registration use case, and async solver registry must exist.  
> **Constraint**: This part **wires everything together** — the hierarchical discovery layer in `IntentUseCaseImpl`, the `AnthropicIntentParser`, the HTTP API endpoints, and the DI composition root. After this part the full feature is live.

---

## Scope

| Creates | Modifies |
|---|---|
| `anthropic.intentParser.ts` | `intent.usecase.ts` (add discovery, pass manifests to parser, await solver) |
| | `httpServer.ts` (add `POST /tools`, `GET /tools`) |
| | `assistant.di.ts` (wire all new deps) |

---

## Architecture recap — Hierarchical Discovery Layer

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

**Hexagonal compliance**: `IntentUseCaseImpl` is application-core. It calls output port `IToolManifestDB`. The `AnthropicIntentParser` adapter receives manifests as a parameter — it never holds a DB reference. No adapter calls another adapter.

---

## Step 7 — Update `IntentUseCaseImpl` (discovery + async solver)

File: `src/use-cases/implementations/intent.usecase.ts`

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

### 7e. Replace `getSolver` → `getSolverAsync` in both methods

In `parseAndExecute`:
```typescript
// Old:
const solver = this.solverRegistry.getSolver(intent.action);
// New:
const solver = await this.solverRegistry.getSolverAsync(intent.action);
```

In `confirmAndExecute`:
```typescript
// Old:
const solver = this.solverRegistry.getSolver(intentPackage.action);
// New:
const solver = await this.solverRegistry.getSolverAsync(intentPackage.action);
```

`confirmAndExecute` does **not** call `discoverRelevantTools` — the `IntentPackage` is already stored in DB with the resolved `action`. Only the solver lookup changes.

---

## Step 8 — Create `AnthropicIntentParser`

File: `src/adapters/implementations/output/intentParser/anthropic.intentParser.ts`

This adapter:
- Implements `IIntentParser`
- Constructor takes `apiKey: string` and `model: string` — **no `toolManifestDB`**
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

The LLM output schema (Zod) must accept `action: z.string()` (not `z.enum([...])`) to allow dynamic toolIds. Builtin actions remain in the enum description within the system prompt.

`params` field is added to the LLM response schema: `params: z.record(z.unknown()).nullable()`.

---

## Step 9 — HTTP API endpoints

File: `src/adapters/implementations/input/http/httpServer.ts`

Add two new routes. Inject `IToolRegistrationUseCase` as a new optional constructor parameter on `HttpApiServer`, consistent with how `intentUseCase` is already injected.

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
1. Parse chainId from query string if present
2. IToolRegistrationUseCase.list(chainId)
3. Return 200 { tools: ToolManifest[] }
```

---

## Step 10 — DI wiring in `assistant.di.ts`

```
1. DrizzleToolManifestRepo → updated impl (Part 1), still a property on DrizzleSqlDB
2. ToolRegistrationUseCaseImpl → new, takes sqlDB.toolManifests
3. SolverRegistry → pass sqlDB.toolManifests as second constructor arg (Part 2)
4. IntentUseCaseImpl → pass sqlDB.toolManifests as new constructor arg (Step 7)
5. AnthropicIntentParser → no toolManifestDB injection (Step 8 design)
6. HttpApiServer → pass toolRegistrationUseCase as new constructor arg (Step 9)
```

No other DI changes.

---

## Step 11 — Migration for existing data

Run `db:generate` after the schema.ts change from Part 1 (if not already run). The existing `tool_manifests` table has no production data (all solvers are hardcoded), so the generated migration is a clean drop-and-recreate. Verify migration applies cleanly against the dev database.

---

## File change inventory — Part 3

| File | Action |
|---|---|
| `src/adapters/implementations/output/intentParser/anthropic.intentParser.ts` | **Create** |
| `src/use-cases/implementations/intent.usecase.ts` | Add `toolManifestDB` constructor param, add `discoverRelevantTools()` + `resolveConflicts()`, await `getSolverAsync` in both methods, pass manifests to parser, pass manifest to validator |
| `src/adapters/implementations/input/http/httpServer.ts` | Add `POST /tools` and `GET /tools` routes; inject `IToolRegistrationUseCase` |
| `src/adapters/inject/assistant.di.ts` | Wire: `ToolRegistrationUseCaseImpl`, updated `SolverRegistry`, updated `IntentUseCaseImpl`, `AnthropicIntentParser`, updated `HttpApiServer` |
| `drizzle/` | Verify migration applied (from Part 1); re-run `db:generate` only if schema.ts was not yet migrated |

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
| Hexagonal violation (adapter calling repo) | Fixed: parser receives manifests as parameter; only use case calls `IToolManifestDB` |

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
