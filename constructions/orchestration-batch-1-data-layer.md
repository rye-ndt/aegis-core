# Orchestration Upgrade — Batch 1: Data Layer

## What this batch does

Adds the DB columns, migration, and TypeScript interfaces/repos needed by Batches 2 and 3.
No business logic. Everything here is pure data structures and SQL.

**After this batch:** run `npm run db:migrate` and `tsc --noEmit`. Both must pass before Batch 2.

## Prerequisites

None. This batch has no dependencies.

---

## Step 1 — DB Schema + Migration

### 1a — Schema changes

**File:** `src/adapters/implementations/output/sqlDB/schema.ts`

Add `boolean` to the drizzle-orm import:
```typescript
import { boolean, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
```

Extend the `conversations` table with three new columns:
```typescript
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  summary: text("summary"),
  intent: text("intent"),
  flaggedForCompression: boolean("flagged_for_compression").notNull().default(false),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
```

Extend the `messages` table — add one nullable column after `toolCallsJson`:
```typescript
compressedAtEpoch: integer("compressed_at_epoch"),
```

Add the new `evaluationLogs` table at the end of the file:
```typescript
export const evaluationLogs = pgTable("evaluation_logs", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  messageId: uuid("message_id").notNull(),
  userId: uuid("user_id").notNull(),
  systemPromptHash: text("system_prompt_hash").notNull(),
  memoriesInjected: text("memories_injected").notNull().default("[]"),
  toolCalls: text("tool_calls").notNull().default("[]"),
  reasoningTrace: text("reasoning_trace"),
  response: text("response").notNull(),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  implicitSignal: text("implicit_signal"),
  explicitRating: integer("explicit_rating"),
  outcomeConfirmed: boolean("outcome_confirmed"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
});
```

### 1b — Migration SQL

**New file:** `drizzle/0006_orchestration_upgrade.sql`

```sql
ALTER TABLE "conversations" ADD COLUMN "summary" text;
ALTER TABLE "conversations" ADD COLUMN "intent" text;
ALTER TABLE "conversations" ADD COLUMN "flagged_for_compression" boolean NOT NULL DEFAULT false;
ALTER TABLE "messages" ADD COLUMN "compressed_at_epoch" integer;

CREATE TABLE "evaluation_logs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "conversation_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "system_prompt_hash" text NOT NULL,
  "memories_injected" text NOT NULL DEFAULT '[]',
  "tool_calls" text NOT NULL DEFAULT '[]',
  "reasoning_trace" text,
  "response" text NOT NULL,
  "prompt_tokens" integer,
  "completion_tokens" integer,
  "implicit_signal" text,
  "explicit_rating" integer,
  "outcome_confirmed" boolean,
  "created_at_epoch" integer NOT NULL
);
```

### 1c — Update journal

**File:** `drizzle/meta/_journal.json` — append to the `entries` array:
```json
{
  "idx": 6,
  "version": "7",
  "when": <Date.now() at migration time>,
  "tag": "0006_orchestration_upgrade",
  "breakpoints": true
}
```

Run: `npm run db:migrate`

---

## Step 2 — Conversation Interface + Repo

### 2a — Interface

**File:** `src/use-cases/interface/output/repository/conversation.repo.ts`

Full replacement:
```typescript
import { CONVERSATION_STATUSES } from "../../../../helpers/enums/statuses.enum";

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  status: CONVERSATION_STATUSES;
  summary?: string | null;
  intent?: string | null;
  flaggedForCompression: boolean;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IConversationDB {
  create(conversation: Conversation): Promise<void>;
  update(conversation: Conversation): Promise<void>;
  findById(id: string): Promise<Conversation | null>;
  findByUserId(userId: string): Promise<Conversation[]>;
  delete(id: string): Promise<void>;
  upsertSummary(id: string, summary: string): Promise<void>;
  updateIntent(id: string, intent: string): Promise<void>;
  flagForCompression(id: string): Promise<void>;
}
```

### 2b — Concrete repo

**File:** `src/adapters/implementations/output/sqlDB/repositories/conversation.repo.ts`

Update `create()` to pass `flaggedForCompression`:
```typescript
async create(conversation: Conversation): Promise<void> {
  await this.db.insert(conversations).values({
    id: conversation.id,
    userId: conversation.userId,
    title: conversation.title,
    status: conversation.status,
    flaggedForCompression: conversation.flaggedForCompression,
    createdAtEpoch: conversation.createdAtEpoch,
    updatedAtEpoch: conversation.updatedAtEpoch,
  });
}
```

Update the return mapping in both `findById()` and `findByUserId()` to include the new fields:
```typescript
// findById return:
return {
  ...rows[0],
  status: rows[0].status as CONVERSATION_STATUSES,
  summary: rows[0].summary ?? null,
  intent: rows[0].intent ?? null,
  flaggedForCompression: rows[0].flaggedForCompression,
};

// findByUserId .map():
return rows.map((r) => ({
  ...r,
  status: r.status as CONVERSATION_STATUSES,
  summary: r.summary ?? null,
  intent: r.intent ?? null,
  flaggedForCompression: r.flaggedForCompression,
}));
```

Add the three new methods at the end of the class:
```typescript
async upsertSummary(id: string, summary: string): Promise<void> {
  await this.db
    .update(conversations)
    .set({ summary })
    .where(eq(conversations.id, id));
}

async updateIntent(id: string, intent: string): Promise<void> {
  await this.db
    .update(conversations)
    .set({ intent })
    .where(eq(conversations.id, id));
}

async flagForCompression(id: string): Promise<void> {
  await this.db
    .update(conversations)
    .set({ flaggedForCompression: true })
    .where(eq(conversations.id, id));
}
```

---

## Step 3 — Message Interface + Repo

### 3a — Interface

**File:** `src/use-cases/interface/output/repository/message.repo.ts`

Full replacement:
```typescript
import { MESSAGE_ROLE } from "../../../../helpers/enums/messageRole.enum";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";

export interface Message {
  id: string;
  conversationId: string;
  role: MESSAGE_ROLE;
  content: string;
  toolName?: TOOL_TYPE;
  toolCallId?: string;
  toolCallsJson?: string;
  compressedAtEpoch?: number | null;
  createdAtEpoch: number;
}

export interface IMessageDB {
  create(message: Message): Promise<void>;
  findByConversationId(conversationId: string): Promise<Message[]>;
  findUncompressedByConversationId(conversationId: string): Promise<Message[]>;
  markCompressed(ids: string[], epoch: number): Promise<void>;
  deleteByConversationId(conversationId: string): Promise<void>;
}
```

`findUncompressedByConversationId` returns all messages with `compressed_at_epoch IS NULL` ordered
by `created_at_epoch ASC`. The caller takes `.slice(-20)` for the sliding window.

### 3b — Concrete repo

**File:** `src/adapters/implementations/output/sqlDB/repositories/message.repo.ts`

Update imports — add `and`, `inArray`, `isNull`:
```typescript
import { and, eq, inArray, isNull } from "drizzle-orm";
```

Update `create()` to persist `compressedAtEpoch`:
```typescript
async create(message: Message): Promise<void> {
  await this.db.insert(messages).values({
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    toolName: message.toolName ?? null,
    toolCallId: message.toolCallId ?? null,
    toolCallsJson: message.toolCallsJson ?? null,
    compressedAtEpoch: message.compressedAtEpoch ?? null,
    createdAtEpoch: message.createdAtEpoch,
  });
}
```

Update `findByConversationId()` return mapping to include `compressedAtEpoch`:
```typescript
return rows.map((r) => ({
  ...r,
  role: r.role as MESSAGE_ROLE,
  toolName: r.toolName ? (r.toolName as TOOL_TYPE) : undefined,
  toolCallId: r.toolCallId ?? undefined,
  toolCallsJson: r.toolCallsJson ?? undefined,
  compressedAtEpoch: r.compressedAtEpoch ?? undefined,
}));
```

Add the two new methods at the end of the class:
```typescript
async findUncompressedByConversationId(conversationId: string): Promise<Message[]> {
  const rows = await this.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        isNull(messages.compressedAtEpoch),
      ),
    )
    .orderBy(messages.createdAtEpoch);

  return rows.map((r) => ({
    ...r,
    role: r.role as MESSAGE_ROLE,
    toolName: r.toolName ? (r.toolName as TOOL_TYPE) : undefined,
    toolCallId: r.toolCallId ?? undefined,
    toolCallsJson: r.toolCallsJson ?? undefined,
    compressedAtEpoch: r.compressedAtEpoch ?? undefined,
  }));
}

async markCompressed(ids: string[], epoch: number): Promise<void> {
  if (ids.length === 0) return;
  await this.db
    .update(messages)
    .set({ compressedAtEpoch: epoch })
    .where(inArray(messages.id, ids));
}
```

---

## Step 4 — EvaluationLog Interface + Repo

### 4a — Interface

**New file:** `src/use-cases/interface/output/repository/evaluationLog.repo.ts`

```typescript
export interface EvaluationLog {
  id: string;
  conversationId: string;
  messageId: string;
  userId: string;
  systemPromptHash: string;
  memoriesInjected: string;   // JSON: Array<{ id: string; score: number }>
  toolCalls: string;          // JSON: Array<IToolResult>
  reasoningTrace?: string | null;
  response: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  implicitSignal?: string | null;
  explicitRating?: number | null;
  outcomeConfirmed?: boolean | null;
  createdAtEpoch: number;
}

export interface IEvaluationLogDB {
  create(log: EvaluationLog): Promise<void>;
  findLastByConversation(conversationId: string, skip?: number): Promise<EvaluationLog | null>;
  updateImplicitSignal(id: string, signal: string): Promise<void>;
}
```

`findLastByConversation(id, skip = 0)` returns the most recent log row for the conversation,
optionally skipping `skip` rows. `skip = 1` is used by Phase 8b to read the *previous* turn's log.

### 4b — Concrete repo

**New file:** `src/adapters/implementations/output/sqlDB/repositories/evaluationLog.repo.ts`

```typescript
import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  EvaluationLog,
  IEvaluationLogDB,
} from "../../../../../use-cases/interface/output/repository/evaluationLog.repo";
import { evaluationLogs } from "../schema";

export class DrizzleEvaluationLogRepo implements IEvaluationLogDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(log: EvaluationLog): Promise<void> {
    await this.db.insert(evaluationLogs).values({
      id: log.id,
      conversationId: log.conversationId,
      messageId: log.messageId,
      userId: log.userId,
      systemPromptHash: log.systemPromptHash,
      memoriesInjected: log.memoriesInjected,
      toolCalls: log.toolCalls,
      reasoningTrace: log.reasoningTrace ?? null,
      response: log.response,
      promptTokens: log.promptTokens ?? null,
      completionTokens: log.completionTokens ?? null,
      implicitSignal: log.implicitSignal ?? null,
      explicitRating: log.explicitRating ?? null,
      outcomeConfirmed: log.outcomeConfirmed ?? null,
      createdAtEpoch: log.createdAtEpoch,
    });
  }

  async findLastByConversation(
    conversationId: string,
    skip = 0,
  ): Promise<EvaluationLog | null> {
    const rows = await this.db
      .select()
      .from(evaluationLogs)
      .where(eq(evaluationLogs.conversationId, conversationId))
      .orderBy(desc(evaluationLogs.createdAtEpoch))
      .limit(1)
      .offset(skip);

    if (!rows[0]) return null;
    return {
      ...rows[0],
      reasoningTrace: rows[0].reasoningTrace ?? undefined,
      promptTokens: rows[0].promptTokens ?? undefined,
      completionTokens: rows[0].completionTokens ?? undefined,
      implicitSignal: rows[0].implicitSignal ?? undefined,
      explicitRating: rows[0].explicitRating ?? undefined,
      outcomeConfirmed: rows[0].outcomeConfirmed ?? undefined,
    };
  }

  async updateImplicitSignal(id: string, signal: string): Promise<void> {
    await this.db
      .update(evaluationLogs)
      .set({ implicitSignal: signal })
      .where(eq(evaluationLogs.id, id));
  }
}
```

---

## Verification

1. Run `npm run db:migrate` — must complete without error. Confirm the three new columns appear
   in `conversations`, `compressed_at_epoch` appears in `messages`, and `evaluation_logs` table
   exists.

2. Run `tsc --noEmit` — must produce zero errors. The updated interfaces and new repo file must
   type-check cleanly.
