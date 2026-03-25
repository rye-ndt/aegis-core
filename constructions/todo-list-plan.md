# To-Do List Tool Plan

## Goal

JARVIS can remember timely tasks that the user must do later but that don't belong on the calendar.
The user says something like _"remind me to submit the expense report by Friday"_ or _"add a to-do
to call the dentist, high priority, deadline next Monday"_. JARVIS creates a structured record in
the DB. The user can later ask _"what do I have to do?"_ and JARVIS retrieves the open items sorted
by urgency and deadline.

---

## Agentic Flow Overview

### Creating a to-do item

```
User utterance
      │
      ▼
[LLM → TOOL CALL]  create_todo_item
  Required fields: title, deadlineEpoch, priority
  If either deadline or priority is absent in the tool call:
      → tool returns { success: false, error: "..." } with an instruction
        telling the LLM exactly what to ask the user
      → LLM asks the user, receives the answer, retries the tool call
      → repeat until both fields are present
  Once both present:
      → repo.create() persists the record
      → tool returns { success: true, data: "To-do item saved: ..." }
      │
      ▼
[LLM TEXT REPLY]
  Confirms the saved item to the user (title, priority, deadline).
```

### Retrieving to-do items

```
User utterance  ("what do I have to do?", "show my tasks", etc.)
      │
      ▼
[LLM → TOOL CALL]  retrieve_todo_items
  Optional: status filter (default "open"), priority filter
      │
      ▼
[TOOL]
  Queries DB for matching rows.
  Sorts by priority weight (urgent > high > medium > low) then deadlineEpoch ASC.
  Formats results as a numbered list.
      │
      ▼
[LLM TEXT REPLY]
  Presents the list to the user.
```

---

## DB Schema

**Table:** `todo_items`

```typescript
// src/adapters/implementations/output/sqlDB/schema.ts
export const todoItems = pgTable("todo_items", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  deadlineEpoch: integer("deadline_epoch").notNull(),
  priority: text("priority").notNull(),   // "low" | "medium" | "high" | "urgent"
  status: text("status").notNull(),       // "open" | "done"
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
```

**Field rationale:**
- `deadlineEpoch` — required, seconds since epoch, same convention as all other `*_at_epoch` columns
- `priority` — four-level text enum. Stored as text to match the pattern of other text-typed enums
  in this schema (e.g. `status`, `role`)
- `status` — `"open"` | `"done"` covers the single-user lifecycle; no concept of assignee or
  multi-state workflow needed
- `description` — nullable; the LLM may enrich a user's utterance into a short description, but it
  is not prompted to do so

---

## Tool Definitions

### Tool 1 — `create_todo_item`

**Purpose:** Create a single to-do item in the DB.

**When LLM calls this:** When the user asks JARVIS to remember a future task that does not fit
the calendar (no specific appointment/invite context). The LLM must supply title, deadline, and
priority. If either is missing, the tool self-validates and returns an actionable error that loops
the conversation back to the user.

**Input schema:**
```typescript
const InputSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe("Short description of the task, as stated by the user"),
  description: z
    .string()
    .optional()
    .describe("Optional longer detail or note about the task"),
  deadlineEpoch: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Deadline as a Unix timestamp in seconds (UTC). " +
      "Derive from the user's stated deadline (e.g. 'by Friday', 'next Monday'). " +
      "If the user did not mention a deadline, do NOT guess — leave this field out."
    ),
  priority: z
    .enum(["low", "medium", "high", "urgent"])
    .optional()
    .describe(
      "Task urgency. Use 'urgent' only when the user says it is urgent or critical. " +
      "If the user did not state a priority, leave this field out."
    ),
});
```

**Self-validation loop:**

Inside `execute()`:
1. If `deadlineEpoch` is absent → return:
   ```
   { success: false, error: 'Deadline is required. Ask the user: "By when do you need to complete this?" Then retry with deadlineEpoch set.' }
   ```
2. If `priority` is absent → return:
   ```
   { success: false, error: 'Priority is required. Ask the user: "How urgent is this — low, medium, high, or urgent?" Then retry with priority set.' }
   ```
3. Both present → persist and return `{ success: true, data: "To-do saved: ..." }`.

**Output (IToolOutput.data):**
```
To-do saved: "Submit expense report" | Priority: high | Deadline: 2026-03-28 00:00 UTC | ID: <uuid>
```

---

### Tool 2 — `retrieve_todo_items`

**Purpose:** Retrieve open (or filtered) to-do items for the user.

**When LLM calls this:** When the user asks what tasks they have, what they need to do, or anything
that implies listing or reviewing their to-do list.

**Input schema:**
```typescript
const InputSchema = z.object({
  status: z
    .enum(["open", "done", "all"])
    .default("open")
    .describe("Filter by status. Default is 'open' (pending tasks only)."),
  priority: z
    .enum(["low", "medium", "high", "urgent"])
    .optional()
    .describe("Optional priority filter. Omit to return all priorities."),
});
```

**Sorting:** `urgent` > `high` > `medium` > `low`, then `deadlineEpoch ASC` within each bucket.
Sorting is done in TypeScript (not SQL) using a priority weight map — keeps the repo interface
simple and avoids a Drizzle `case` expression.

**Output (IToolOutput.data):** Formatted string, e.g.:
```
1. [URGENT] Submit tax return — due 2026-04-15
2. [HIGH]   Call dentist — due 2026-03-30
3. [MEDIUM] Review PR #42 — due 2026-03-28
```

If no items found:
```
No open to-do items found.
```

---

## Files to Create / Modify

### New files

| File | Purpose |
|------|---------|
| `src/use-cases/interface/output/repository/todoItem.repo.ts` | Domain type `TodoItem` + outbound port `ITodoItemDB` |
| `src/adapters/implementations/output/sqlDB/repositories/todoItem.repo.ts` | Drizzle implementation of `ITodoItemDB` |
| `src/adapters/implementations/output/tools/createTodoItem.ts` | `CreateTodoItemTool` — write tool |
| `src/adapters/implementations/output/tools/retrieveTodoItems.ts` | `RetrieveTodoItemsTool` — read tool |

### Modified files

| File | Change |
|------|--------|
| `src/adapters/implementations/output/sqlDB/schema.ts` | Add `todoItems` table definition |
| `src/helpers/enums/toolType.enum.ts` | Add `CREATE_TODO_ITEM` and `RETRIEVE_TODO_ITEMS` |
| `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` | Add `todoItems: DrizzleTodoItemRepo` property + constructor wiring |
| `src/adapters/inject/assistant.di.ts` | Register both tools in `registryFactory` |

After modifying `schema.ts`: run `npm run db:generate && npm run db:migrate`.

---

## Step-by-Step Implementation

### Step A — Domain type + port interface

**File:** `src/use-cases/interface/output/repository/todoItem.repo.ts`

```typescript
export type TodoPriority = "low" | "medium" | "high" | "urgent";
export type TodoStatus = "open" | "done";

export interface TodoItem {
  id: string;
  userId: string;
  title: string;
  description?: string;
  deadlineEpoch: number;
  priority: TodoPriority;
  status: TodoStatus;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface ITodoItemDB {
  create(item: TodoItem): Promise<void>;
  findByUserId(userId: string, status?: TodoStatus): Promise<TodoItem[]>;
  markDone(id: string, updatedAtEpoch: number): Promise<void>;
}
```

---

### Step B — Schema

**File:** `src/adapters/implementations/output/sqlDB/schema.ts` — append:

```typescript
export const todoItems = pgTable("todo_items", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  deadlineEpoch: integer("deadline_epoch").notNull(),
  priority: text("priority").notNull(),
  status: text("status").notNull(),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
```

Then run: `npm run db:generate && npm run db:migrate`

---

### Step C — Drizzle repo

**File:** `src/adapters/implementations/output/sqlDB/repositories/todoItem.repo.ts`

```typescript
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  ITodoItemDB,
  TodoItem,
  TodoStatus,
} from "../../../../../use-cases/interface/output/repository/todoItem.repo";
import { todoItems } from "../schema";

export class DrizzleTodoItemRepo implements ITodoItemDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(item: TodoItem): Promise<void> {
    await this.db.insert(todoItems).values({
      id: item.id,
      userId: item.userId,
      title: item.title,
      description: item.description ?? null,
      deadlineEpoch: item.deadlineEpoch,
      priority: item.priority,
      status: item.status,
      createdAtEpoch: item.createdAtEpoch,
      updatedAtEpoch: item.updatedAtEpoch,
    });
  }

  async findByUserId(userId: string, status?: TodoStatus): Promise<TodoItem[]> {
    const conditions = status
      ? and(eq(todoItems.userId, userId), eq(todoItems.status, status))
      : eq(todoItems.userId, userId);

    const rows = await this.db.select().from(todoItems).where(conditions);
    return rows.map(this.toItem);
  }

  async markDone(id: string, updatedAtEpoch: number): Promise<void> {
    await this.db
      .update(todoItems)
      .set({ status: "done", updatedAtEpoch })
      .where(eq(todoItems.id, id));
  }

  private toItem(row: typeof todoItems.$inferSelect): TodoItem {
    return {
      id: row.id,
      userId: row.userId,
      title: row.title,
      description: row.description ?? undefined,
      deadlineEpoch: row.deadlineEpoch,
      priority: row.priority as TodoItem["priority"],
      status: row.status as TodoItem["status"],
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
```

---

### Step D — Enum values

**File:** `src/helpers/enums/toolType.enum.ts` — add:
```typescript
CREATE_TODO_ITEM = "create_todo_item",
RETRIEVE_TODO_ITEMS = "retrieve_todo_items",
```

---

### Step E — DrizzleSqlDB adapter

**File:** `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts`

Add import:
```typescript
import { DrizzleTodoItemRepo } from "./repositories/todoItem.repo";
```

Add property + constructor line (same pattern as `userMemories`):
```typescript
readonly todoItems: DrizzleTodoItemRepo;
// in constructor:
this.todoItems = new DrizzleTodoItemRepo(this.db);
```

---

### Step F — `CreateTodoItemTool`

**File:** `src/adapters/implementations/output/tools/createTodoItem.ts`

```typescript
import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { ITodoItemDB } from "../../../../use-cases/interface/output/repository/todoItem.repo";

const InputSchema = z.object({
  title: z.string().min(1).describe("Short description of the task"),
  description: z.string().optional().describe("Optional longer note about the task"),
  deadlineEpoch: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Deadline as a Unix timestamp in seconds (UTC). " +
      "Derive from the user's stated deadline. If not mentioned, omit this field."
    ),
  priority: z
    .enum(["low", "medium", "high", "urgent"])
    .optional()
    .describe(
      "Task urgency. Use 'urgent' only when explicitly stated. If not mentioned, omit this field."
    ),
});

export class CreateTodoItemTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly todoItemRepo: ITodoItemDB,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.CREATE_TODO_ITEM,
      description:
        "Save a task or to-do item the user needs to complete by a deadline. " +
        "Use this when the user mentions something they need to do later that is NOT a calendar event. " +
        "Requires a title, deadline, and priority. If either deadline or priority is missing, " +
        "this tool will tell you what to ask the user — then retry once you have both.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const parsed = InputSchema.parse(input);

    if (parsed.deadlineEpoch === undefined) {
      return {
        success: false,
        error:
          'Deadline is required. Ask the user: "By when do you need to complete this?" ' +
          "Convert their answer to a Unix timestamp in seconds, then retry with deadlineEpoch set.",
      };
    }

    if (parsed.priority === undefined) {
      return {
        success: false,
        error:
          'Priority is required. Ask the user: "How urgent is this — low, medium, high, or urgent?" ' +
          "Then retry with priority set.",
      };
    }

    const now = newCurrentUTCEpoch();
    const id = newUuid();

    await this.todoItemRepo.create({
      id,
      userId: this.userId,
      title: parsed.title,
      description: parsed.description,
      deadlineEpoch: parsed.deadlineEpoch,
      priority: parsed.priority,
      status: "open",
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });

    const deadlineStr = new Date(parsed.deadlineEpoch * 1000).toUTCString();
    return {
      success: true,
      data:
        `To-do saved: "${parsed.title}" | Priority: ${parsed.priority} | ` +
        `Deadline: ${deadlineStr} | ID: ${id}`,
    };
  }
}
```

---

### Step G — `RetrieveTodoItemsTool`

**File:** `src/adapters/implementations/output/tools/retrieveTodoItems.ts`

```typescript
import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type {
  ITodoItemDB,
  TodoItem,
  TodoPriority,
  TodoStatus,
} from "../../../../use-cases/interface/output/repository/todoItem.repo";

const PRIORITY_WEIGHT: Record<TodoPriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const InputSchema = z.object({
  status: z
    .enum(["open", "done", "all"])
    .default("open")
    .describe("Filter by status. Default is 'open'."),
  priority: z
    .enum(["low", "medium", "high", "urgent"])
    .optional()
    .describe("Optional priority filter. Omit to return all priorities."),
});

export class RetrieveTodoItemsTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly todoItemRepo: ITodoItemDB,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.RETRIEVE_TODO_ITEMS,
      description:
        "Retrieve the user's to-do list. Returns tasks sorted by urgency then deadline. " +
        "Call this when the user asks what they need to do, lists their tasks, or checks pending items.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const { status, priority } = InputSchema.parse(input);

    const statusFilter: TodoStatus | undefined =
      status === "all" ? undefined : status;

    let items = await this.todoItemRepo.findByUserId(this.userId, statusFilter);

    if (priority) {
      items = items.filter((i) => i.priority === priority);
    }

    if (items.length === 0) {
      return { success: true, data: "No to-do items found." };
    }

    items.sort((a, b) => {
      const weightDiff =
        PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
      return weightDiff !== 0 ? weightDiff : a.deadlineEpoch - b.deadlineEpoch;
    });

    const formatted = items
      .map((item, i) => {
        const deadline = new Date(item.deadlineEpoch * 1000).toUTCString();
        const tag = item.priority.toUpperCase().padEnd(6);
        const desc = item.description ? ` — ${item.description}` : "";
        return `${i + 1}. [${tag}] ${item.title}${desc} | due ${deadline} | status: ${item.status}`;
      })
      .join("\n");

    return { success: true, data: formatted };
  }
}
```

---

### Step H — DI wiring

**File:** `src/adapters/inject/assistant.di.ts`

Add imports:
```typescript
import { CreateTodoItemTool } from "../implementations/output/tools/createTodoItem";
import { RetrieveTodoItemsTool } from "../implementations/output/tools/retrieveTodoItems";
```

Inside `registryFactory(userId)`, add two `r.register(...)` calls:
```typescript
r.register(new CreateTodoItemTool(userId, sqlDB.todoItems));
r.register(new RetrieveTodoItemsTool(userId, sqlDB.todoItems));
```

---

## System Prompt Guidance

Add to the JARVIS system prompt (via Drizzle Studio or `npm run db:studio`):

```
When the user mentions something they need to do by a deadline that is NOT a calendar appointment:
1. Use create_todo_item. You MUST supply title, deadlineEpoch (Unix seconds UTC), and priority.
2. If the user did not state a deadline, ask before calling the tool.
3. If the user did not state a priority, ask before calling the tool.
4. After saving, confirm the task title, priority, and deadline to the user.

When the user asks what they have to do, what their tasks are, or anything about their to-do list:
1. Use retrieve_todo_items. Default status filter is "open".
2. Present the results as a clear numbered list.
```

---

## What is explicitly NOT in scope

- Marking tasks as done (no `mark_todo_done` tool) — out of scope for this iteration
- Editing existing tasks
- Reminders / push notifications via Telegram cron
- Recurring tasks
