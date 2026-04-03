# Orchestration Upgrade — Batch 2: Infrastructure

## What this batch does

Two surgical changes:
1. Adds a `usage` field to `IOrchestratorResponse` and surfaces it in the OpenAI implementation.
2. Adds `evaluationLogs` as a typed property on `DrizzleSqlDB`.

Both are small. Neither touches business logic.

**After this batch:** run `tsc --noEmit`. Must pass before Batch 3.

## Prerequisites

Batch 1 must be complete and compiling. Specifically:
- `DrizzleEvaluationLogRepo` must exist at
  `src/adapters/implementations/output/sqlDB/repositories/evaluationLog.repo.ts`
- `evaluationLogs` table must exist in `src/adapters/implementations/output/sqlDB/schema.ts`

---

## Step 5 — Add `usage` to `IOrchestratorResponse` + OpenAI impl

### 5a — Interface

**File:** `src/use-cases/interface/output/orchestrator.interface.ts`

Add `usage` to `IOrchestratorResponse`. The field is optional — non-OpenAI adapters that don't
surface token counts can omit it.

```typescript
export interface IOrchestratorResponse {
  text?: string;
  toolCalls?: IToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}
```

No other changes to this file.

### 5b — OpenAI orchestrator

**File:** `src/adapters/implementations/output/orchestrator/openai.ts`

Inside `chat()`, after `const choice = response.choices[0]`, extract usage:

```typescript
const usage = response.usage
  ? {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
    }
  : undefined;
```

Add `usage` to both return paths:

```typescript
// tool calls path (was: return { toolCalls };):
return { toolCalls, usage };

// text path (was: return { text: message.content ?? "" };):
return { text: message.content ?? "", usage };
```

---

## Step 6 — Update `DrizzleSqlDB` Adapter

**File:** `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts`

Add import:
```typescript
import { DrizzleEvaluationLogRepo } from "./repositories/evaluationLog.repo";
```

Add property declaration alongside the existing repo properties:
```typescript
readonly evaluationLogs: DrizzleEvaluationLogRepo;
```

Instantiate in the constructor body alongside the other repos:
```typescript
this.evaluationLogs = new DrizzleEvaluationLogRepo(this.db);
```

---

## Verification

Run `tsc --noEmit` — zero errors required.

Spot-check: the OpenAI orchestrator's `chat()` return type must now satisfy
`IOrchestratorResponse` with the optional `usage` field on both code paths.
