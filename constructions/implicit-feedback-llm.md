# Plan: LLM-based implicit feedback detection

## Goal

Replace the brittle keyword-matching `detectImplicitSignal()` function with an LLM-based analysis that reads the N messages that followed a given turn, then updates both `implicit_signal` and `outcome_confirmed` on that turn's `evaluation_logs` row.

`N` is controlled by the env var `FEEDBACK_WINDOW_SIZE` (default `3`).

---

## Problem with the current approach

`detectImplicitSignal()` in `assistant.usecase.ts` (lines 74–112) uses hardcoded keyword lists to classify the _very next_ user message. It:

- Misses positive feedback entirely (`outcomeConfirmed` is never written).
- Matches superficially ("no," as a standalone word fires "correction" even when unrelated).
- Only looks at one message; a correction can be subtle and span two messages.

---

## How the new approach works

On every turn, `postProcess()` evaluates the evaluation log from `FEEDBACK_WINDOW_SIZE` turns ago:

1. Fetch `targetLog = evaluationLogRepo.findLastByConversation(conversationId, FEEDBACK_WINDOW_SIZE)`.
2. If `targetLog` is not found, or `targetLog.implicitSignal` is already set (already evaluated), stop.
3. Fetch the `FEEDBACK_WINDOW_SIZE` messages written after `targetLog.createdAtEpoch` (USER + ASSISTANT roles only, ascending order).
4. If fewer than `FEEDBACK_WINDOW_SIZE` messages have arrived, stop — the window is not full yet.
5. Send the original assistant response + the follow-up messages to `textGenerator.generate()`.
6. Parse the JSON result. Update `implicitSignal` and/or `outcomeConfirmed` on `targetLog`.

This guarantees the window is always evaluated exactly once, as soon as enough data exists.

---

## Files to change

### 1. `src/use-cases/interface/output/repository/message.repo.ts`

Add one method to `IMessageDB`:

```typescript
findAfterEpoch(
  conversationId: string,
  afterEpoch: number,
  limit: number,
): Promise<Message[]>;
```

Returns messages where `createdAtEpoch > afterEpoch`, ordered ascending, capped at `limit`. Includes only USER and ASSISTANT roles — excludes ASSISTANT_TOOL_CALL and TOOL rows.

### 2. `src/adapters/implementations/output/sqlDB/repositories/message.repo.ts`

Implement the new method in `DrizzleMessageRepo`. `inArray` is already imported. Add `gt` and `asc` to the existing `drizzle-orm` import.

```typescript
async findAfterEpoch(
  conversationId: string,
  afterEpoch: number,
  limit: number,
): Promise<Message[]> {
  const rows = await this.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gt(messages.createdAtEpoch, afterEpoch),
        inArray(messages.role, [MESSAGE_ROLE.USER, MESSAGE_ROLE.ASSISTANT]),
      ),
    )
    .orderBy(asc(messages.createdAtEpoch))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    role: r.role as MESSAGE_ROLE,
    toolName: r.toolName ? (r.toolName as TOOL_TYPE) : undefined,
    toolCallId: r.toolCallId ?? undefined,
    toolCallsJson: r.toolCallsJson ?? undefined,
    compressedAtEpoch: r.compressedAtEpoch ?? undefined,
  }));
}
```

Imports to add to the existing `drizzle-orm` import: `gt`, `asc`.

### 3. `src/use-cases/implementations/assistant.usecase.ts`

#### 3a. Remove `detectImplicitSignal()`

Delete the entire function (lines 74–112) and its call site in `postProcess()` (lines 496–504).

#### 3b. Remove the old call site

In `postProcess()`, remove:

```typescript
const prevLog = await this.evaluationLogRepo.findLastByConversation(
  ctx.conversationId,
  1,
);
if (prevLog) {
  const signal = detectImplicitSignal(ctx.userMessage, prevLog.response);
  if (signal) {
    await this.evaluationLogRepo.updateImplicitSignal(prevLog.id, signal);
  }
}
```

#### 3c. Add `DEFAULT_FEEDBACK_WINDOW_SIZE` constant

At the top of the file alongside `DEFAULT_MAX_TOOL_ROUNDS`, add:

```typescript
const DEFAULT_FEEDBACK_WINDOW_SIZE = 3;
```

#### 3d. Add `evaluatePastTurn()` private method

Add this method to `AssistantUseCaseImpl`:

```typescript
private async evaluatePastTurn(
  conversationId: string,
  windowSize: number,
): Promise<void> {
  const targetLog = await this.evaluationLogRepo.findLastByConversation(
    conversationId,
    windowSize,
  );
  if (!targetLog || targetLog.implicitSignal != null) return;

  const followUps = await this.messageRepo.findAfterEpoch(
    conversationId,
    targetLog.createdAtEpoch,
    windowSize,
  );
  if (followUps.length < windowSize) return;

  const context =
    `Assistant response being evaluated:\n${targetLog.response}\n\n` +
    `Follow-up conversation:\n` +
    formatMessagesForPrompt(followUps);

  const raw = await this.textGenerator.generate(
    "Analyze whether the user's follow-up messages indicate implicit feedback about the assistant response. " +
      "Return a JSON object with exactly two fields:\n" +
      "  signal: one of \"correction\" | \"repeat\" | \"clarification\" | \"positive\" | null\n" +
      "    - correction: user indicates the response was wrong or needs to be changed\n" +
      "    - repeat: user asks again for something the assistant already answered\n" +
      "    - clarification: user indicates the response was unclear or asks for more detail\n" +
      "    - positive: user explicitly confirms the response was correct or helpful\n" +
      "    - null: no clear feedback signal\n" +
      "  outcomeConfirmed: true if the user confirmed the outcome was correct, false if they rejected it, null if unclear.\n" +
      "Return only valid JSON. No markdown, no explanation.",
    context,
  );

  let signal: string | null = null;
  let outcomeConfirmed: boolean | null = null;
  try {
    const parsed = JSON.parse(raw) as {
      signal?: string | null;
      outcomeConfirmed?: boolean | null;
    };
    const validSignals = ["correction", "repeat", "clarification", "positive"];
    signal =
      typeof parsed.signal === "string" && validSignals.includes(parsed.signal)
        ? parsed.signal
        : null;
    outcomeConfirmed =
      typeof parsed.outcomeConfirmed === "boolean"
        ? parsed.outcomeConfirmed
        : null;
  } catch {
    return;
  }

  await Promise.all([
    signal !== null
      ? this.evaluationLogRepo.updateImplicitSignal(targetLog.id, signal)
      : Promise.resolve(),
    outcomeConfirmed !== null
      ? this.evaluationLogRepo.updateOutcomeConfirmed(
          targetLog.id,
          outcomeConfirmed,
        )
      : Promise.resolve(),
  ]);
}
```

#### 3e. Call `evaluatePastTurn()` in `postProcess()`

After the `await this.evaluationLogRepo.create(...)` block and before the memory extraction block, add:

```typescript
const windowSize = parseInt(process.env.FEEDBACK_WINDOW_SIZE ?? String(DEFAULT_FEEDBACK_WINDOW_SIZE));
await this.evaluatePastTurn(ctx.conversationId, windowSize);
```

### 4. `.env.example`

Add the new variable (place it near the other configurable numeric defaults like `MAX_TOOL_ROUNDS`):

```
FEEDBACK_WINDOW_SIZE=3       # Messages after a turn before evaluating implicit feedback
```

---

## What does NOT change

- `IEvaluationLogDB` — already has `findLastByConversation(conversationId, skip)`, `updateImplicitSignal`, and `updateOutcomeConfirmed`. No changes needed.
- `DrizzleEvaluationLogRepo` — no changes.
- `AssistantUseCaseImpl` constructor — no new dependencies; `messageRepo` is already injected.
- DB schema — no new columns or tables.
- `assistant.di.ts` — no changes.

---

## Conventions to follow

- IDs: `newUuid()` from `helpers/uuid.ts`
- Timestamps: `newCurrentUTCEpoch()` from `helpers/time/dateTime.ts` (seconds, not ms)
- No comments unless the logic is non-obvious
- Errors inside `postProcess()` are already caught by the outer try/catch at line 587 — do not add additional wrapping

---

## Sequence summary

```
Turn N arrives → postProcess() runs
  │
  ├─ Write evaluation_log for turn N
  │
  ├─ evaluatePastTurn(conversationId, FEEDBACK_WINDOW_SIZE)
  │    ├─ Fetch eval log from FEEDBACK_WINDOW_SIZE turns ago (targetLog)
  │    ├─ Skip if not found or already evaluated (implicitSignal != null)
  │    ├─ Fetch next FEEDBACK_WINDOW_SIZE USER+ASSISTANT messages after targetLog.createdAtEpoch
  │    ├─ Skip if fewer than FEEDBACK_WINDOW_SIZE messages found (window not full)
  │    ├─ LLM classifies: { signal, outcomeConfirmed }
  │    └─ Update implicitSignal + outcomeConfirmed on targetLog
  │
  ├─ Memory extraction (unchanged)
  ├─ Intent update (unchanged)
  └─ Compression flag (unchanged)
```

---

## Edge cases

| Case | Behavior |
|------|----------|
| Fewer than `FEEDBACK_WINDOW_SIZE` turns in conversation | `findLastByConversation` returns `null` → skip |
| Window not yet full (< N follow-up messages exist) | `followUps.length < windowSize` → skip; next turn will retry |
| `implicitSignal` already set (non-null/undefined) | Skip — prevents double-evaluation (`!= null` catches both) |
| LLM returns malformed JSON | `JSON.parse` throws → caught → method returns without writing |
| LLM returns valid JSON but unknown signal string | Validation rejects it → `signal = null` |
| Both signal and outcomeConfirmed are null after parse | No DB writes — `Promise.all` resolves two `Promise.resolve()` |
