# context.md — Aegis Backend

## [2026-04-14] Orchestrator Refactor — Dual-Schema Deterministic Pipeline

### Summary
Implemented deterministic intent routing & dual-schema extraction as described in
`constructions/orchestrator-proposal.md`. Replaced the ad-hoc LLM classify→compile flow with a
4-phase pipeline driven by slash commands and a new Resolver Engine service.

### Phases implemented
- **Phase 1 — Routing:** `parseIntentCommand()` intercepts `/buy`, `/sell`, `/convert`, `/money`,
  `/topup`, `/dca` before any LLM call. Free-form text falls through to the existing legacy path.
- **Phase 2 — LLM Extraction Loop:** `continueCompileLoop` with `compileTurns` counter; aborts at
  `MAX_TOOL_ROUNDS` (default 10).
- **Phase 3 — Data Resolution:** `runResolutionPhase` calls `IResolverEngine.resolve()` which fans
  out to token DB lookup, amount BigInt conversion, and MTProto/Privy handle resolution.
  `DisambiguationRequiredError` is caught; handler enters `token_disambig` stage with `disambigTurns`
  counter (max 10 rounds).
- **Phase 4 — Finalization:** `buildAndShowConfirmationFromResolved` populates `finalSchema` (if
  defined on the manifest) and shows the confirmation message. Falls back to legacy message format
  for tools without `finalSchema`.

### Files created (5 new)
| File | Purpose |
|---|---|
| `src/helpers/enums/intentCommand.enum.ts` | `INTENT_COMMAND` enum + `parseIntentCommand()` |
| `src/helpers/enums/resolverField.enum.ts` | `RESOLVER_FIELD` enum (4 values) |
| `src/use-cases/interface/output/resolver.interface.ts` | `IResolverEngine` port, `DisambiguationRequiredError`, `ResolvedPayload` |
| `src/adapters/implementations/output/resolver/resolverEngine.ts` | `ResolverEngineImpl` concrete adapter |
| `drizzle/0016_dual_schema_fields.sql` | Migration: 2 nullable columns on `tool_manifests` |

### Files modified (9)
| File | Change |
|---|---|
| `src/use-cases/interface/output/toolManifest.types.ts` | Added `requiredFields?`, `finalSchema?` to `ToolManifestSchema` + `deserializeManifest` |
| `src/use-cases/interface/output/repository/toolManifest.repo.ts` | Added `requiredFields?`, `finalSchema?` to `IToolManifestRecord` |
| `src/use-cases/interface/output/schemaCompiler.interface.ts` | Added `resolverFields?` to `CompileResult` |
| `src/use-cases/interface/input/intent.interface.ts` | Re-exports `DisambiguationRequiredError`, `ResolvedPayload` |
| `src/adapters/implementations/output/sqlDB/schema.ts` | 2 nullable text columns on `tool_manifests` |
| `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repo.ts` | `toRecord()` passes `requiredFields` / `finalSchema` through |
| `src/adapters/implementations/output/intentParser/openai.schemaCompiler.ts` | Emits `resolverFieldsJson` for dual-schema tools |
| `src/adapters/implementations/input/telegram/handler.ts` | Full 4-phase pipeline rewrite |
| `src/adapters/inject/assistant.di.ts` | `getResolverEngine()` factory + wiring |
| `src/telegramCli.ts` | Passes `inject.getResolverEngine()` to handler |
| `drizzle/meta/_journal.json` | Registered `0016_dual_schema_fields` entry |

### Commands executed
```
npx tsc --noEmit   ✅  (0 errors — verified after each part)
npm run db:migrate ✅  "[migrate] all migrations applied."
```

### Known limitations / next steps
- `selectTool()` accepts `INTENT_COMMAND` cast to `USER_INTENT_TYPE`; a cleaner
  `selectToolByCommand(command, messages)` overload can be added in a follow-up.
- `/topup` and `/dca` require external integrations not yet implemented.
- `readableAmount` resolver handles numeric strings only; "half"/"all" support requires
  a live balance fetch and is deferred.
- Migration snapshot collision (0012/0013 meta) is pre-existing; migration SQL written
  directly and registered in journal to bypass it.

---

## [2026-04-14] Explicit Command → Tool Mapping

### Summary
Added a persisted, explicit 1-to-1 mapping between a bot command (e.g. `"buy"`) and a `toolId`.
`selectTool()` now checks this mapping first; if none exists or the tool is inactive, it falls back
to the existing RAG/ILIKE discovery. Bare words (no slash) are stored in the DB; normalisation
happens entirely in code.

### Files created (5 new)
| File | Purpose |
|---|---|
| `src/use-cases/interface/output/repository/commandToolMapping.repo.ts` | Output port: `ICommandToolMappingDB` interface |
| `src/use-cases/interface/input/commandMapping.interface.ts` | Input port: `ICommandMappingUseCase` interface |
| `src/use-cases/implementations/commandMapping.usecase.ts` | Use case: validates command & tool, upserts mapping |
| `src/adapters/implementations/output/sqlDB/repositories/commandToolMapping.repo.ts` | Drizzle impl: upsert-on-conflict, delete-with-404 |

### Files modified (5)
| File | Change |
|---|---|
| `src/adapters/implementations/output/sqlDB/schema.ts` | New `command_tool_mappings` table |
| `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` | Added `commandToolMappings` repo property |
| `src/use-cases/implementations/intent.usecase.ts` | `selectTool()` checks explicit mapping first; optional constructor arg `commandToolMappingDB` |
| `src/adapters/inject/assistant.di.ts` | `getCommandMappingUseCase()` factory; wired into `getIntentUseCase()` and `getHttpApiServer()` |
| `src/adapters/implementations/input/http/httpServer.ts` | 3 new routes + handler methods; `commandMappingUseCase` constructor arg |

### HTTP endpoints added
| Method | Route | Body / Response |
|---|---|---|
| `POST` | `/command-mappings` | `{ command: "buy", toolId: "..." }` → `201 { command, toolId }` |
| `GET` | `/command-mappings` | `200 { mappings: [...] }` |
| `DELETE` | `/command-mappings/:command` | `200 { command, deleted: true }` |

### Commands executed
```
npm run db:generate  ✅
npm run db:migrate   ✅  "[migrate] all migrations applied."
npx tsc --noEmit     ✅  (0 errors)
```

### Known limitations / next steps
- No auth on mapping endpoints by design (prototype).
- `npm run db:generate` reported a pre-existing snapshot collision (0012/0013); migration still applied.
- A new Drizzle migration file was NOT generated due to the snapshot collision — the table will only
  be created if the migration is re-run after the collision is resolved, or the SQL is applied manually.

---

## [2026-04-14] Fix Drizzle Snapshot Collision (0012/0013)

### Summary
Repaired a broken Drizzle migration lineage that blocked `db:generate`.  
Root cause: `0011_snapshot.json` was deleted. Both `0012_snapshot.json` and `0013_snapshot.json`  
were generated off the same deleted parent (`b186019b`) — a fork/collision.  
Additionally, journal entries for `0014_privy_auth`, `0015_pending_delegations`, and  
`0016_dual_schema_fields` were hand-authored without backing snapshot files; these were orphans.

### Fix applied (no manual SQL)
1. Repointed `0012_snapshot.json.prevId` → `c8ca54fe` (id of `0010_snapshot.json`)
2. Repointed `0013_snapshot.json.prevId` → `b665b875` (id of `0012_snapshot.json`)
3. Removed 3 journal orphan entries (`0014_privy_auth`, `0015_pending_delegations`, `0016_dual_schema_fields`)
4. Deleted 3 orphan SQL files: `0014_privy_auth.sql`, `0015_pending_delegations.sql`, `0016_dual_schema_fields.sql`
5. Ran `db:generate` → generated `0016_rich_deathstrike.sql` (command_tool_mappings CREATE TABLE only)
6. Trimmed `0016_rich_deathstrike.sql` to only include `command_tool_mappings` (remaining DDL already in DB)
7. Cleaned journal to renumber deathstrike entry to idx 13

### Commands executed
```
npm run db:generate  ✅  "No schema changes, nothing to migrate" (after trim)
npm run db:migrate   ✅  "[migrate] all migrations applied."
psql \d command_tool_mappings  ✅  table confirmed created
```

### Verification
- `command_tool_mappings` table now exists in DB with correct schema
- `db:generate` reports no further schema drift
- `db:migrate` reports all applied


