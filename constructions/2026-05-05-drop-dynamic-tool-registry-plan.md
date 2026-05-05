# Drop Dynamic Tool Registry — Implementation Plan

> Authored: 2026-05-05
> Scope: `be/src/` — remove every subsystem that exists to support runtime/API tool registration. Keep only in-code tools registered in DI.
> Predecessor: `2026-05-05-architecture-cleanup-plan.md` (Phase 1.4 rename should land first)
> Estimated impact: **~2,100–2,200 net LOC removed (~9% of `src/`)**, drops Pinecone + OpenAI embedding deps, retires 3 tables.

---

## Decision summary

The original architecture allowed third parties to:
- POST `/tools` to register a JSON-schema'd tool with executable manifest steps
- POST `/command-mappings` to map a slash command to a tool
- POST `/http-tools` for per-user HTTP-query tools
- Have the system embed the tool into Pinecone for RAG-based selection

This path is being **dropped entirely**. All tools will be in-code, registered in `assistant.di.ts` / `systemToolProvider.concrete.ts`. Param extraction (LLM-driven JSON-schema fill) **stays** because `sendCapability` and `swapCapability` both rely on it.

**Critical confirmations from coupling audit (do not re-verify; treat as facts):**
- No frontend code calls `/tools`, `/command-mappings`, or `/http-tools` (FE repo grepped clean).
- No in-code tool depends on `IntentUseCase`, `ISolverRegistry`, `IToolIndexService`, `IEmbeddingService`, `IVectorDB`, or `IToolManifestDB`.
- No background jobs/boot hooks index or refresh tools — Pinecone upsert only fires on `POST /tools`.
- The seeded `transfer` manifest's only step is a single `executeErc20Transfer` — equivalent to ~10 LOC of `viem.encodeFunctionData`.
- `swapCapability` already uses an inline hardcoded `SWAP_MANIFEST` (see `swapCapability.ts:833`) and never reaches the solver. We mirror that pattern for send.
- `OpenAISchemaCompiler` and `IntentUseCase.compileSchema/generateMissingParamQuestion/searchTokens` **stay**. They are not part of the dynamic subsystem; they are part of capability param extraction.

---

## Conventions recap

- Hexagonal: don't leak adapter imports into use-cases.
- Chain-specific values only in `helpers/chainConfig.ts`.
- Logging: every catch logs `log.error({ err, ... }, "...")` before responding/rethrowing. New scope per module.
- Migrations: drizzle only. New drop-table migration must be **registered** in `_journal.json` (different from gated `0030_drop_intent_tables.sql`).
- Env: anything new goes through `helpers/env/`.

---

## Sequencing (strictly ordered — do not parallelize across phases)

| # | Phase | Risk | Reversible? | Ship after |
|---|---|---|---|---|
| 0 | Pre-flight: finish Phase 1.4 rename from prior plan | low | yes | — |
| A | Delete orphans: `/tools` + `/http-tools` routes & use-cases; `/command-mappings` HTTP routes only (repo + use-case stay until B) | low | yes | 0 |
| B | Define `CapabilityManifest` slim type, inline `SEND_MANIFEST`, replace solver call with direct ERC-20 encoder, delete deferred command-mapping subsystem, trim `IntentUseCase` API | **med** | yes | A |
| C | Delete solver framework, `tool_manifests` repo + zod types, tool RAG (Pinecone + embedding) | low (after B) | yes | B verified in prod ≥1 release |
| D | Drizzle migration to drop `tool_manifests`, `command_tool_mappings`, `http_query_tools`, `http_query_tool_headers` | high (schema) | no | C verified in prod ≥1 release |

Each phase = one PR. Run `npx tsc --noEmit` after every step within a phase. Run `pnpm test` at end of each phase. **Manual smoke /send + /swap before opening Phase B and C PRs.**

---

## Pre-flight — Phase 1.4 rename (from prior plan)

Already specified in `2026-05-05-architecture-cleanup-plan.md` Phase 1.4. Land first so this plan can refer to `SchemaCompileService` consistently. If you decide to skip that rename, treat all `SchemaCompileService` references below as `IntentUseCaseImpl`.

---

## Phase A — Delete orphans (zero behavioral change)

Everything here has zero in-code-tool dependency. Pure dead-on-removal.

### A.1 — Tool registration use case + `/tools` HTTP routes

Delete:
- `src/use-cases/implementations/toolRegistration.usecase.ts` (~118 LOC)
- `src/use-cases/interface/input/toolRegistration.interface.ts` (~14)
- DI getter `getToolRegistrationUseCase` in `assistant.di.ts` (~10)

Edit `src/adapters/implementations/input/http/httpServer.ts`:
- Remove route registrations (lines ~187–193, 223): `POST /tools`, `GET /tools`, `DELETE /tools/:id`.
- Remove handlers `handlePostTools` (lines 357, 378), `handleGetTools` (411, 417), `handleDeleteTool` (393–405).
- Remove health-response key `toolRegistration` (line 1190).
- Remove unused imports.

Verify:
- `rg "toolRegistrationUseCase|IToolRegistrationUseCase|ToolRegistrationUseCase" be/src` → empty.
- `rg "POST /tools|GET /tools|DELETE /tools/" be/src` → empty.
- `npx tsc --noEmit` clean.

### A.2 — Command mapping HTTP routes only (DEFER repo + use-case deletion to Phase B)

> **Why this is split:** Audit confirmed the "ILIKE fallback" assumption is **false**. `intent.usecase.ts:65` builds the search query as `"/send <user text>"` (literal `/send` prefix included). `toolManifest.repo.ts:84-92` ILIKEs against `name`, `description`, `protocolName`, `tags` — none of which contain the `/send ` substring of the seeded `transfer` manifest. Deleting `commandToolMappingDB` in Phase A would cause `selectTool` to return null, and `sendCapability.ts:149` would throw "No tool is registered for /send". **Therefore: delete only the admin HTTP surface in A.2; keep the repo, use-case, and DB read path alive until Phase B inlines `SEND_MANIFEST` and `selectTool` itself goes away.**

Delete in A.2 (admin surface only — no runtime reader of these endpoints):
- HTTP routes in `httpServer.ts`: `POST /command-mappings` (790, 810), `GET /command-mappings` (826, 829), `DELETE /command-mappings/:cmd` (841, 846).
- Health-response key `commandMapping` (line 1195).
- `assistant.di.ts`: remove `getCommandMappingUseCase` getter and any wiring **only used by the deleted routes**.

DO NOT delete in A.2 (deferred to Phase B):
- `src/use-cases/implementations/commandMapping.usecase.ts`
- `src/use-cases/interface/input/commandMapping.interface.ts`
- `src/use-cases/interface/output/repository/commandToolMapping.repo.ts`
- `src/adapters/implementations/output/sqlDB/repositories/commandToolMapping.repo.ts`
- `commandToolMappingDB` accessor in `drizzleSqlDb.adapter.ts` / `sqlDB.interface.ts`
- The explicit-mapping branch at `intent.usecase.ts:51-62`

Verify after A.2: `/send` still works locally (manual smoke), and `rg "POST /command-mappings|GET /command-mappings|DELETE /command-mappings" be/src` → empty.

### A.3 — User HTTP-query tools

Delete:
- `src/use-cases/implementations/httpQueryTool.usecase.ts` (~94)
- `src/use-cases/interface/input/httpQueryTool.interface.ts`
- `src/use-cases/interface/output/repository/httpQueryTool.repo.ts` (~50)
- `src/adapters/implementations/output/sqlDB/repositories/httpQueryTool.repo.ts` (~55)
- `src/adapters/implementations/output/tools/httpQuery.tool.ts` (~150)
- `src/helpers/crypto/aes.ts` **only after** `rg "encryptValue|decryptValue|aes\.ts" be/src` confirms no other consumer.

Edit:
- `httpServer.ts`: remove `POST /http-tools` (868), `GET /http-tools` (904), `DELETE /http-tools/:id`.
- `assistant.di.ts:452–475`: remove the per-user `httpQueryTool` registration loop in the registry factory.
- `drizzleSqlDb.adapter.ts` + `sqlDB.interface.ts`: remove `httpQueryToolDB` accessor.
- Remove unused imports.

Verify:
- `rg "httpQueryTool|HttpQueryTool|http_query_tools" be/src` → empty.
- `rg "encryptValue|decryptValue" be/src` → empty (then delete `aes.ts`).

### A.4 — Update `STATUS.md`

Record what was deleted, why, and that DB tables `tool_manifests`, `command_tool_mappings`, `http_query_tools`, `http_query_tool_headers` are now write-free pending Phase D drop migration.

### A.5 — Tests

- `tests/sendCapability.test.ts` still runs against the existing `selectTool` stub. Keep the test as-is in Phase A; rewrite in Phase B.
- Run full `pnpm test`; everything should pass.

**Phase A LOC removed: ~770** (reduced from earlier ~930 because the ~160 LOC of `commandMapping` use-case + repo defer to Phase B).

---

## Phase B — Rewrite send-capability calldata path

This is the only phase with real behavioral risk. **Manual smoke /send (ERC-20 + native, both on-chain confirmation) is mandatory before opening the PR.**

### B.0 — Define a slim local manifest type (shared with `SWAP_MANIFEST`)

> **Background.** The existing `ToolManifest` zod schema (`use-cases/interface/output/toolManifest.types.ts:58-88`) requires `steps.min(1)` and uses field names that differ from the plan's earlier draft. After Phase C deletes the strict zod type, both `SEND_MANIFEST` and `SWAP_MANIFEST` need a slim, no-zod local type. Define it now so both capabilities can use it consistently.

Create `src/helpers/types/manifest.ts`:
```ts
/** Slim manifest shape for in-code capability tools. Survivor of the dynamic-tool-registry removal. */
export type CapabilityManifest = {
  toolId: string;
  /** Human-readable name. Consumed by autoSign description copy + Telegram confirmations. */
  name: string;
  category: string;
  description: string;
  /** JSON-schema object passed to OpenAISchemaCompiler for LLM param extraction. */
  inputSchema: Record<string, unknown>;
  /** Optional dual-schema marker. Send currently uses single-schema (undefined). */
  requiredFields?: { primary: string[]; alternates?: string[][] };
};
```

Update `swapCapability.ts:833` to type `SWAP_MANIFEST: CapabilityManifest` (the existing constant already conforms field-wise; verify `name` is present and rename `jsonSchema`→`inputSchema` if it diverged).

### B.1 — Inline `SEND_MANIFEST` constant in `sendCapability.ts`

> **Field-name correctness.** The schema field is `inputSchema` (NOT `jsonSchema`) — consumed at `openai.schemaCompiler.ts:47,180`, `intent.usecase.ts:102`, `send.utils.ts:50`. There is **no** `searchKeywords` field — the DB column is `tags`, but our slim type drops it (no runtime consumer outside the deleted RAG path). `manifest.name` is **required** — consumed by `send.messages.ts:42,114` and `sendCapability.ts:237,281` for autoSign description ("Autonomous execution for ${name}") and Telegram confirmation copy. `steps` is omitted entirely (slim type doesn't include it; calldata built directly).

```ts
// sendCapability.ts — top of file, alongside imports
import { CapabilityManifest } from "<rel>/helpers/types/manifest";

const SEND_MANIFEST: CapabilityManifest = {
  toolId: "transfer",
  name: "ERC-20 Token Transfer",                // REQUIRED — used in user-facing description copy
  category: "erc20_transfer",                    // matches seed value at drizzle/0023_seed_send_tool.sql
  description: "Send tokens to a recipient address or telegram handle",
  inputSchema: {
    // Copy VERBATIM from drizzle/0023_seed_send_tool.sql:36 (the inputSchema JSON column).
    // Includes properties: tokenSymbol, recipient, amountHuman, etc. — preserve exact field
    // names, descriptions, and required[] array so OpenAISchemaCompiler extracts identically.
  },
  // requiredFields intentionally omitted — seed has NULL → usesDualSchema()=false (sendCapability.ts:684-687)
};
```

**Acceptance check before merging B.1:** open `drizzle/0023_seed_send_tool.sql` and `0024_seed_send_tool_fix.sql`, copy the `input_schema` JSON column verbatim into the TypeScript object literal. Diff against current LLM extraction behavior on `/send 1 USDC to 0x...`.

### B.2 — Replace `selectTool` call with inline manifest

`sendCapability.ts:146` currently:
```ts
const manifest = await this.deps.intentUseCase.selectTool(this.command, [text]);
```
Replace with:
```ts
const manifest = SEND_MANIFEST;
```

Audit downstream uses of `manifest` in `sendCapability.ts` — every read should be one of: `manifest.toolId`, `manifest.name`, `manifest.inputSchema`, `manifest.description`, `manifest.requiredFields`, `manifest.category`. No other field accesses should remain. Run `rg "manifest\.\w+" src/adapters/implementations/output/capabilities/sendCapability.ts` to confirm.

### B.3 — Replace `buildRequestBody` with direct ERC-20 encoder

`sendCapability.ts:160` currently calls `intentUseCase.buildRequestBody(...)` → solver chain → `executeErc20Transfer`.

Replace with a local helper (~15 LOC, mirrors `stepExecutors.ts:118-157`):

```ts
// sendCapability.ts — private method
private buildTransferCalldata(input: {
  tokenAddress: string;
  recipient: string;
  amountRaw: string;
}): { to: `0x${string}`; data: `0x${string}`; value: string } {
  if (isNativeAddress(input.tokenAddress)) {
    return { to: input.recipient as `0x${string}`, data: "0x", value: input.amountRaw };
  }
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [input.recipient as `0x${string}`, BigInt(input.amountRaw)],
  });
  return { to: input.tokenAddress as `0x${string}`, data, value: "0" };
}
```

Use `isNativeAddress` from `helpers/chainConfig.ts` (existing). Use `erc20Abi` from `viem` (existing).

Logging per CLAUDE.md:
```ts
log.info({ step: "calldata-built", toolId: SEND_MANIFEST.toolId }, "transfer-calldata-ready");
```

### B.3.5 — Delete deferred command-mapping subsystem

Once B.2 has replaced `selectTool` with the inline `SEND_MANIFEST`, the explicit-mapping branch at `intent.usecase.ts:51-62` is reachable but unused (`selectTool` itself becomes dead in B.4). Delete now to keep B atomic:

Delete:
- `src/use-cases/implementations/commandMapping.usecase.ts` (~71)
- `src/use-cases/interface/input/commandMapping.interface.ts`
- `src/use-cases/interface/output/repository/commandToolMapping.repo.ts` (~17)
- `src/adapters/implementations/output/sqlDB/repositories/commandToolMapping.repo.ts` (~65)

Edit:
- `intent.usecase.ts:51-62`: remove the explicit-mapping branch (whole block).
- `drizzleSqlDb.adapter.ts` + `sqlDB.interface.ts`: remove `commandToolMappingDB` accessor.
- `assistant.di.ts`: remove `commandToolMappingDB` from `IntentUseCaseImpl` deps; drop the getter entirely.

Verify: `rg "commandToolMapping|commandMappingUseCase|CommandMapping" be/src` → empty.

### B.4 — Trim `IntentUseCase` API

`SchemaCompileService` (post Phase 1.4) keeps:
- `compileSchema(...)` — used by send + swap
- `generateMissingParamQuestion(...)` — used by send + swap
- `searchTokens(...)` — used by send (lines 618, 626)

Remove from the class and interface:
- `selectTool` (no callers after B.2)
- `buildRequestBody` (no callers after B.3)
- `discoverRelevantTools` (private, was only called by `selectTool`)
- `resolveConflicts` (private, only called by `discoverRelevantTools`)

Remove from constructor `deps`:
- `commandToolMappingDB` (already gone from DI in A.2)
- `toolManifestDB`
- `solverRegistry`
- `toolIndexService`

Update DI wiring in `assistant.di.ts` accordingly.

Verify: `rg "selectTool|buildRequestBody|discoverRelevantTools" be/src` → empty.

### B.5 — Update tests

`tests/sendCapability.test.ts`:
- Remove `selectTool` stub (no longer called).
- Stub `compileSchema` returning the parameter shape send actually consumes.
- Add a unit test for `buildTransferCalldata`: ERC-20 case + native case (compare against `viem.encodeFunctionData` golden).

### B.6 — Smoke + ship

Manual checklist before opening PR:
- [ ] `/send 1 USDC to 0x...` on testnet — calldata matches pre-refactor (compare against staging/canary).
- [ ] `/send 0.001 BNB to 0x...` (native) — value field set correctly, data is `0x`.
- [ ] `/send 1 USDC to @telegramhandle` — telegram-resolution path still works (this is in `searchTokens`/handle resolution, not in calldata).
- [ ] Logs at `info` level show `transfer-calldata-ready` event.

**Phase B LOC removed: ~310** (intent.usecase trims ~150 + deferred commandMapping subsystem ~160). **LOC added: ~50** (SEND_MANIFEST + buildTransferCalldata + `helpers/types/manifest.ts`). **Net ~260 removed.**

---

## Phase C — Delete solver framework, manifest repo, tool RAG

Only safe after Phase B is in production for ≥1 release with no /send regressions.

### C.1 — Delete solver framework

Delete:
- `src/adapters/implementations/output/solver/manifestSolver/manifestDriven.solver.ts` (~45)
- `src/adapters/implementations/output/solver/manifestSolver/stepExecutors.ts` (~170)
- `src/adapters/implementations/output/solver/manifestSolver/templateEngine.ts` (~46)
- `src/adapters/implementations/output/solver/solverRegistry.ts` (~38)
- `src/use-cases/interface/output/solver/solver.interface.ts`
- `src/use-cases/interface/output/solver/solverRegistry.interface.ts`

Remove DI wiring in `assistant.di.ts` (lines 120, 174, 288–295, 393).

Verify: `rg "solverRegistry|ISolverRegistry|ManifestDrivenSolver|ISolver|stepExecutors|templateEngine" be/src` → empty.

### C.2 — Delete `tool_manifests` repo + zod types

> **Pre-req:** `helpers/types/manifest.ts` (created in B.0) must already define `CapabilityManifest` and both `SEND_MANIFEST` / `SWAP_MANIFEST` must use it. This phase deletes the heavyweight zod-validated `ToolManifest` from `use-cases/interface/output/toolManifest.types.ts` — verify NO file imports `ToolManifest`, `ToolManifestSchema`, `ToolStep`, `ToolStepSchema`, or `deserializeManifest` from that path before deleting.

Delete:
- `src/use-cases/interface/output/toolManifest.types.ts` (~112) — entire file. The slim `CapabilityManifest` lives in `helpers/types/manifest.ts` and replaces every legitimate consumer.
- `src/use-cases/interface/output/repository/toolManifest.repo.ts` (~43)
- `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repo.ts` (~136)

Edit:
- `drizzleSqlDb.adapter.ts` + `sqlDB.interface.ts`: remove `toolManifestDB` accessor.
- `assistant.di.ts`: remove `getToolManifestRepo` getter.

Verify (each grep must return empty):
- `rg "toolManifestDB|IToolManifestDB" be/src`
- `rg "from .*toolManifest\.types" be/src`
- `rg "ToolManifestSchema|ToolStepSchema|deserializeManifest" be/src`
- `rg "import.*ToolManifest[^a-zA-Z]" be/src` — if any survive, swap to `CapabilityManifest`.

### C.3 — Delete tool RAG (Pinecone + embedding)

Delete:
- `src/adapters/implementations/output/toolIndex/pinecone.toolIndex.ts` (~74)
- `src/adapters/implementations/output/vectorDB/pinecone.ts` (~56)
- `src/adapters/implementations/output/embedding/openai.ts` (~30)
- `src/use-cases/interface/output/toolIndex.interface.ts` (~25)
- `src/use-cases/interface/output/vectorDB.interface.ts` (~21)
- `src/use-cases/interface/output/embedding.interface.ts` (~3)

Edit `assistant.di.ts`:
- Remove `getToolVectorStore`, `getToolIndexService`, `getEmbeddingService` getters (lines 328–338 area).

Edit `helpers/env/`:
- Remove `PINECONE_*` and `OPENAI_EMBEDDING_*` env getters; mark as removed in `.env.example`.

Edit `package.json`:
- Remove `@pinecone-database/pinecone` (and any embedding-only deps unique to this path).
- `pnpm install` to refresh the lockfile.

Verify:
- `rg "pinecone|Pinecone|toolIndex|embedding|vectorDB" be/src` → empty.
- `rg "PINECONE_" be/` → only `.env.example` (commented out) and migration notes.

### C.4 — Update `STATUS.md`

Record solver-framework removal, Pinecone removal, and that the `OpenAISchemaCompiler` is the single LLM dependency for capability param extraction.

### C.5 — Tests + smoke

- Re-run full test suite.
- Manual smoke: `/send`, `/swap`, `/get_portfolio`, `/get_transfer_history`, `/route_intent` (free-form NL).

**Phase C LOC removed: ~750.**

---

## Phase D — Drizzle migration: drop dead tables

Only after Phase C is in production for ≥1 release.

### D.1 — Generate migration

Create `drizzle/0031_drop_dynamic_tool_tables.sql`:

```sql
-- Phase D of dynamic-tool-registry removal (see constructions/2026-05-05-drop-dynamic-tool-registry-plan.md).
-- Safe to run once Phase A+B+C have shipped: code no longer reads these tables.
DROP TABLE IF EXISTS http_query_tool_headers;
DROP TABLE IF EXISTS http_query_tools;
DROP TABLE IF EXISTS command_tool_mappings;
DROP TABLE IF EXISTS tool_manifests;
```

Register in `drizzle/meta/_journal.json` (this is **not** a gated migration like 0030 — Phase D's whole point is to actually drop).

Edit `src/adapters/implementations/output/sqlDB/schema.ts`:
- Remove `toolManifests` (lines ~117–195 area), `commandToolMappings` (~166), `httpQueryTools`, `httpQueryToolHeaders` table declarations.

Verify:
- `npx drizzle-kit generate` produces no diff.
- `npx tsc --noEmit` clean.
- Apply migration in staging; smoke /send + /swap; only then prod.

### D.2 — Cleanup

- Remove the now-orphaned seed migrations from any local docs that reference them (`0023_seed_send_tool.sql`, `0024_seed_send_tool_fix.sql`, `0013_dynamic_tool_registry.sql`, `0014_*`, `0016_*` rich_deathstrike/foamy_frog_thor). **Do not delete the migration files themselves** — historical migrations are immutable.
- Final `STATUS.md` entry summarizing the full removal.

**Phase D LOC removed: ~70 (schema declarations).**

---

## Total impact

| Phase | LOC removed | LOC added | Net |
|---|---|---|---|
| A | ~770 | 0 | -770 |
| B | ~310 | ~50 | -260 |
| C | ~750 | 0 | -750 |
| D | ~70 | ~10 (migration SQL) | -60 |
| **Total** | **~1,900** | **~60** | **~-1,840** |

Plus:
- 4 dropped tables.
- 5+ admin HTTP routes gone.
- Pinecone + embedding service eliminated → simpler infra, lower cost, no env vars.
- Single mental model for tools.
- ~2,200–2,300 LOC if we're generous about counting deleted DI wiring, schema declarations, migration `.sql` headers, and `package.json` deps.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Send breaks during Phase A.2 (ILIKE fallback misses seeded manifest) | **Resolved by plan v2:** A.2 now deletes only HTTP routes; `commandToolMappingDB` and the explicit-mapping branch survive until Phase B.3.5 deletes them atomically with the `selectTool` removal. |
| `SEND_MANIFEST` template uses wrong field names (`jsonSchema` vs `inputSchema`, missing `name`) | **Resolved by plan v2:** B.0 defines `CapabilityManifest` slim type with correct fields; B.1 spells out the `name` requirement and points to the exact seed migration line for `inputSchema` JSON. |
| Send calldata regression in Phase B | Manual smoke on testnet for ERC-20 + native + telegram-handle paths; unit test against golden `encodeFunctionData` output. |
| Schema-compiler accidentally deleted | Explicit "do not delete" callout: `OpenAISchemaCompiler` and `compileSchema`/`generateMissingParamQuestion`/`searchTokens` survive Phase B/C. |
| Hidden Pinecone consumer outside `intent.usecase` | Verified by audit (no other consumers); re-grep before deleting in C.3. |
| `aes.ts` removed but used elsewhere | Re-grep `encryptValue|decryptValue` before deleting in A.3. |
| Migration 0031 drops table that production code still queries | Wait full release cycle after Phase C. Inspect logs for any `relation does not exist` warnings from staging before prod. |
| Frontend regression from removed `/tools` etc. | Pre-verified: zero FE consumers. Re-grep FE repo before merging A. |

---

## Definition of done (per phase)

- [ ] All deletions/edits applied; `npx tsc --noEmit` clean from `be/`.
- [ ] `pnpm test` passes; new tests added for any rewritten code paths (Phase B).
- [ ] All `rg` audits in the phase return zero unintended hits.
- [ ] `STATUS.md` updated with what + why + new conventions.
- [ ] Manual smoke completed for any user-facing flow touched (mandatory in Phase B + C).
- [ ] PR description explicitly lists any suspected regression per CLAUDE.md "Quality bar".
- [ ] For Phase D: staging migration applied + smoked before prod.
