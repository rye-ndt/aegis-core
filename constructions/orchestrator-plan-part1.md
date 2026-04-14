# Orchestrator Refactor — Part 1: Dual-Schema Model & Resolver Infrastructure

**Goal:** Add `requiredFields` / `finalSchema` to `ToolManifest`, define the enum-keyed resolver pattern,
and extend the intent command enum — without touching the handler or use-case layers yet.  
All changes in this part are additive (no deletions). Existing behaviour is fully preserved.

---

## 1. Overview

The proposal introduces a **Dual-Schema Model**:

| Schema | Owner | Who fills it | Purpose |
|---|---|---|---|
| `requiredFields` | Tool manifest | LLM (structured extraction) | Human-readable parameter set |
| `finalSchema` | Tool manifest | Background resolvers | Machine-readable, on-chain parameters |

Each field inside `requiredFields` maps 1-to-1 to a **Resolver** that converts the human value into a
machine value stored in `finalSchema`. This part wires the data model; Parts 2–4 implement the pipeline.

---

## 2. Safety Checklist (before touching any file)

- [ ] Run `npm run typecheck` from `/be` to record a clean baseline. **Stop if it already has errors.**
- [ ] Commit (or stash) all current changes before starting.
- [ ] All new types are additive — no existing field is renamed or removed.
- [ ] Part 1 ships no logic changes to running code paths.

---

## 3. Files to modify / create

### 3.1 `src/helpers/enums/intentCommand.enum.ts` — **[NEW]**

Create the canonical enum that maps slash commands to tool categories. This replaces the
ad-hoc `USER_INTENT_TYPE` used in the handler routing branch.

```typescript
// src/helpers/enums/intentCommand.enum.ts
export enum INTENT_COMMAND {
  MONEY   = "/money",
  BUY     = "/buy",
  SELL    = "/sell",
  CONVERT = "/convert",
  TOPUP   = "/topup",
  DCA     = "/dca",
}

/**
 * Returns the INTENT_COMMAND if the raw message text starts with one
 * of the recognised slash commands, otherwise null.
 */
export function parseIntentCommand(text: string): INTENT_COMMAND | null {
  const lower = text.trim().toLowerCase();
  for (const cmd of Object.values(INTENT_COMMAND)) {
    if (lower === cmd || lower.startsWith(`${cmd} `) || lower.startsWith(`${cmd}\n`)) {
      return cmd as INTENT_COMMAND;
    }
  }
  return null;
}
```

**Guard:** These values are only used inside the Telegram handler (Part 3). Introducing the enum now
has zero runtime impact.

---

### 3.2 `src/helpers/enums/resolverField.enum.ts` — **[NEW]**

Canonical enum of every field name that the LLM is allowed to extract in `requiredFields`.
The resolver pipeline (Part 2) uses these keys to fan out to the correct resolver function.

```typescript
// src/helpers/enums/resolverField.enum.ts

/**
 * Every key that may appear in a tool manifest's requiredFields schema.
 * Each key has a dedicated resolver function in ResolverEngine (Part 2).
 */
export enum RESOLVER_FIELD {
  FROM_TOKEN_SYMBOL  = "fromTokenSymbol",
  TO_TOKEN_SYMBOL    = "toTokenSymbol",
  READABLE_AMOUNT    = "readableAmount",
  USER_HANDLE        = "userHandle",
}
```

---

### 3.3 `src/use-cases/interface/output/toolManifest.types.ts` — **[MODIFY]**

Add the optional `requiredFields` and `finalSchema` properties to `ToolManifestSchema` and the
`ToolManifest` type that Zod generates from it.

**Exact diff to apply:**

```diff
 export const ToolManifestSchema = z.object({
   toolId:       z.string().min(3).max(64).regex(/^[a-z0-9-]+$/),
   category:     z.nativeEnum(TOOL_CATEGORY),
   name:         z.string().min(1).max(100),
   description:  z.string().min(10).max(500),
   protocolName: z.string().min(1).max(100),
   tags:         z.array(z.string()).min(1),
   priority:     z.number().int().min(0).default(0),
   isDefault:    z.boolean().default(false),
   inputSchema:  z.record(z.string(), z.unknown()),
   steps:        z.array(ToolStepSchema).min(1),
   preflightPreview: z.object({
     label:         z.string(),
     valueTemplate: z.string(),
   }).optional(),
   revenueWallet: z.string().optional(),
   chainIds:      z.array(z.number()).min(1),
+  /**
+   * Human-readable schema: the LLM extracts these fields from natural language.
+   * Keys must be values of RESOLVER_FIELD enum.
+   * Shape: JSON Schema object — same format as inputSchema.
+   */
+  requiredFields: z.record(z.string(), z.unknown()).optional(),
+  /**
+   * Machine-readable schema: fields populated by the resolver pipeline.
+   * Populated after all requiredFields resolvers complete.
+   */
+  finalSchema: z.record(z.string(), z.unknown()).optional(),
 });
```

**After the diff**, also update `deserializeManifest` to pick up the two new fields:

```diff
 export function deserializeManifest(record: IToolManifestRecord): ToolManifest {
   return {
     toolId:           record.toolId,
     ...
     chainIds:         JSON.parse(record.chainIds) as number[],
+    requiredFields:   record.requiredFields ? JSON.parse(record.requiredFields) as Record<string, unknown> : undefined,
+    finalSchema:      record.finalSchema    ? JSON.parse(record.finalSchema)    as Record<string, unknown> : undefined,
   };
 }
```

**Guard:** Both fields are `optional()`. Existing manifests that lack them continue to work exactly
as before. No DB schema change is needed yet (the columns will be added in Part 2).

---

### 3.4 `src/use-cases/interface/output/repository/toolManifest.repo.ts` — **[MODIFY]**

Add the two optional string columns to `IToolManifestRecord` so `deserializeManifest` can read them.

First, view the current file:

```
src/use-cases/interface/output/repository/toolManifest.repo.ts
```

Add at the end of the `IToolManifestRecord` interface:

```typescript
  requiredFields?:  string | null;   // JSON string | null
  finalSchema?:     string | null;   // JSON string | null
```

**Guard:** Adding optional fields to an interface is backwards-compatible. All existing Drizzle
`findBy*` calls return records that satisfy the extended interface.

---

### 3.5 `src/adapters/implementations/output/sqlDB/schema.ts` — **[MODIFY]**

Add the two new nullable text columns to the `tool_manifests` Drizzle table.

Locate the `tool_manifests` table definition and add:

```typescript
  requiredFields:    text("required_fields"),
  finalSchema:       text("final_schema"),
```

**Guard:** These are nullable text columns — they default to `NULL` in the DB for every existing row.
No data migration is required. Run `npm run db:generate && npm run db:migrate` after this part.

---

### 3.6 `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repository.ts` — **[MODIFY]**

Ensure the mapper inside the repository passes the two new fields through.

Locate the row-to-record mapping (typically a `toRecord` helper or inline object spread) and add:

```typescript
  requiredFields: row.requiredFields ?? null,
  finalSchema:    row.finalSchema    ?? null,
```

---

### 3.7 `src/use-cases/interface/output/schemaCompiler.interface.ts` — **[MODIFY]**

Extend `CompileResult` to make token symbols and the telegram handle extraction aware of the new
`requiredFields` scheme. Add a `resolverFields` output map that the new pipeline (Part 2) will consume.

```diff
 export interface CompileResult {
   params:          Record<string, unknown>;
   missingQuestion: string | null;
   tokenSymbols:    { from?: string; to?: string };
   telegramHandle?: string;
+  /**
+   * Present only when the tool uses the dual-schema model.
+   * Maps each RESOLVER_FIELD key to the raw human-provided value
+   * (before resolution). The resolver engine (Part 2) reads this.
+   */
+  resolverFields?: Partial<Record<string, string>>;
 }
```

---

## 4. Database migration

After modifying `schema.ts`, run:

```bash
cd /Users/rye/Downloads/aegis/be
npm run db:generate
npm run db:migrate
```

Verify: `\d tool_manifests` in psql — should show `required_fields text` and `final_schema text` columns,
both nullable.

---

## 5. Verification

```bash
cd /Users/rye/Downloads/aegis/be
npm run typecheck   # must pass with 0 errors
npm run build       # must succeed
```

No behaviour change. All existing Telegram flows continue to work identically because:
- `requiredFields` / `finalSchema` on the manifest are never read by any existing code path.
- `resolverFields` on `CompileResult` is optional and only checked in Part 3.

---

## 6. What Part 2 builds on top of this

Part 2 implements the **Resolver Engine** — a new output-port service (`IResolverEngine`) that
reads the `resolverFields` map produced by the schema compiler and runs the four resolver functions
(`fromTokenSymbol`, `toTokenSymbol`, `readableAmount`, `userHandle`), including the disambiguation
sub-loop state machine.
