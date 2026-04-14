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
