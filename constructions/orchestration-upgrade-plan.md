# Orchestration Upgrade — Index

Upgrades `AssistantUseCaseImpl.chat()` from a minimal sequential loop to a full 10-phase pipeline:
compression, sliding window, proactive memory injection, richer system prompt, parallel tool
execution, evaluation logging, and async post-processing.

## Execution Order

Execute the three batches in order. After each batch: compile (`tsc --noEmit`) and run the
verification steps listed in that batch's plan before starting the next.

| Batch | File | Scope | Depends on |
|-------|------|-------|------------|
| 1 | `orchestration-batch-1-data-layer.md` | Schema, migration, interfaces, repos | nothing |
| 2 | `orchestration-batch-2-infrastructure.md` | Orchestrator usage field, DrizzleSqlDB adapter | Batch 1 |
| 3 | `orchestration-batch-3-business-logic.md` | AssistantUseCaseImpl rewrite, DI wiring | Batches 1 + 2 |

## Files Changed (all batches)

| File | Batch | Action |
|------|-------|--------|
| `drizzle/0006_orchestration_upgrade.sql` | 1 | New migration |
| `drizzle/meta/_journal.json` | 1 | Add entry idx 6 |
| `src/adapters/implementations/output/sqlDB/schema.ts` | 1 | Add columns + evaluationLogs table |
| `src/use-cases/interface/output/repository/conversation.repo.ts` | 1 | Add fields + 3 methods |
| `src/adapters/implementations/output/sqlDB/repositories/conversation.repo.ts` | 1 | Implement new methods |
| `src/use-cases/interface/output/repository/message.repo.ts` | 1 | Add field + 2 methods |
| `src/adapters/implementations/output/sqlDB/repositories/message.repo.ts` | 1 | Implement new methods |
| `src/use-cases/interface/output/repository/evaluationLog.repo.ts` | 1 | New interface |
| `src/adapters/implementations/output/sqlDB/repositories/evaluationLog.repo.ts` | 1 | New implementation |
| `src/use-cases/interface/output/orchestrator.interface.ts` | 2 | Add `usage?` to response |
| `src/adapters/implementations/output/orchestrator/openai.ts` | 2 | Return `response.usage` |
| `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` | 2 | Add `evaluationLogs` property |
| `src/use-cases/implementations/assistant.usecase.ts` | 3 | Full rewrite |
| `src/adapters/inject/assistant.di.ts` | 3 | Wire new constructor args |
