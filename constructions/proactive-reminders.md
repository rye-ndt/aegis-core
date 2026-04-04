# Proactive Reminders — Implementation Plan

## Overview

JARVIS will proactively send reminder messages via Telegram when:
1. A todo item deadline is approaching (24 h before)
2. A Google Calendar event is about to start (30 min before)

**Delivery:** `bot.api.sendMessage(chatId, text)` — same Telegram bot, initiated by the server.

**Queue store:** PostgreSQL `scheduled_notifications` table — no external queue needed.

**Process model:** `setInterval` loops running inside the existing `telegramCli.ts` process.

---

## New env var

Add to `.env.example` and `.env`:

```
TELEGRAM_CHAT_ID=<your numeric telegram chat id>
```

The user can find this by messaging `@userinfobot` on Telegram.

---

## Phase 1 — DB schema

### 1a. Add table definition to `src/adapters/implementations/output/sqlDB/schema.ts`

Append after the `evaluationLogs` table:

```typescript
export const scheduledNotifications = pgTable("scheduled_notifications", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  fireAtEpoch: integer("fire_at_epoch").notNull(),
  status: text("status").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
}, (table) => ({
  statusFireIdx: index("idx_scheduled_notifications_status_fire").on(table.status, table.fireAtEpoch),
}));
```

Add `index` to the drizzle-orm import at the top of `schema.ts`:
```typescript
import { boolean, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
```

After adding, run:
```
npm run db:generate && npm run db:migrate
```

---

## Phase 2 — Domain interface

### 2a. Create `src/use-cases/interface/output/repository/scheduledNotification.repo.ts`

```typescript
export type NotificationStatus = "pending" | "sent" | "failed";
export type NotificationSourceType = "todo" | "calendar";

export interface ScheduledNotification {
  id: string;
  userId: string;
  title: string;
  body: string;
  fireAtEpoch: number;
  status: NotificationStatus;
  sourceType: NotificationSourceType;
  sourceId: string;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IScheduledNotificationDB {
  create(notification: ScheduledNotification): Promise<void>;
  findDue(nowEpoch: number): Promise<ScheduledNotification[]>;
  findBySourceId(sourceId: string): Promise<ScheduledNotification | null>;
  markSent(id: string, updatedAtEpoch: number): Promise<void>;
  markFailed(id: string, updatedAtEpoch: number): Promise<void>;
}
```

---

## Phase 3 — Drizzle repository

### 3a. Create `src/adapters/implementations/output/sqlDB/repositories/scheduledNotification.repo.ts`

```typescript
import { and, eq, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IScheduledNotificationDB,
  ScheduledNotification,
} from "../../../../../use-cases/interface/output/repository/scheduledNotification.repo";
import { scheduledNotifications } from "../schema";

export class DrizzleScheduledNotificationRepo implements IScheduledNotificationDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(notification: ScheduledNotification): Promise<void> {
    await this.db.insert(scheduledNotifications).values({
      id: notification.id,
      userId: notification.userId,
      title: notification.title,
      body: notification.body,
      fireAtEpoch: notification.fireAtEpoch,
      status: notification.status,
      sourceType: notification.sourceType,
      sourceId: notification.sourceId,
      createdAtEpoch: notification.createdAtEpoch,
      updatedAtEpoch: notification.updatedAtEpoch,
    });
  }

  async findDue(nowEpoch: number): Promise<ScheduledNotification[]> {
    const rows = await this.db
      .select()
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.status, "pending"),
          lte(scheduledNotifications.fireAtEpoch, nowEpoch),
        ),
      );
    return rows.map(this.toNotification);
  }

  async findBySourceId(sourceId: string): Promise<ScheduledNotification | null> {
    const rows = await this.db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.sourceId, sourceId))
      .limit(1);
    return rows.length > 0 ? this.toNotification(rows[0]) : null;
  }

  async markSent(id: string, updatedAtEpoch: number): Promise<void> {
    await this.db
      .update(scheduledNotifications)
      .set({ status: "sent", updatedAtEpoch })
      .where(eq(scheduledNotifications.id, id));
  }

  async markFailed(id: string, updatedAtEpoch: number): Promise<void> {
    await this.db
      .update(scheduledNotifications)
      .set({ status: "failed", updatedAtEpoch })
      .where(eq(scheduledNotifications.id, id));
  }

  private toNotification(
    row: typeof scheduledNotifications.$inferSelect,
  ): ScheduledNotification {
    return {
      id: row.id,
      userId: row.userId,
      title: row.title,
      body: row.body,
      fireAtEpoch: row.fireAtEpoch,
      status: row.status as ScheduledNotification["status"],
      sourceType: row.sourceType as ScheduledNotification["sourceType"],
      sourceId: row.sourceId,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
```

---

## Phase 4 — Register repo in DrizzleSqlDB

### 4a. Edit `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts`

Add the import at the top (with the other repo imports):
```typescript
import { DrizzleScheduledNotificationRepo } from "./repositories/scheduledNotification.repo";
```

Add the property declaration (with the others):
```typescript
readonly scheduledNotifications: DrizzleScheduledNotificationRepo;
```

Instantiate in the constructor body (with the others):
```typescript
this.scheduledNotifications = new DrizzleScheduledNotificationRepo(this.db);
```

---

## Phase 5 — INotificationSender interface

### 5a. Create `src/use-cases/interface/output/notificationSender.interface.ts`

```typescript
export interface INotificationSender {
  send(text: string): Promise<void>;
}
```

---

## Phase 6 — TelegramBot: implement INotificationSender

### 6a. Edit `src/adapters/implementations/input/telegram/bot.ts`

Replace the entire file with:

```typescript
import { Bot } from "grammy";
import type { TelegramAssistantHandler } from "./handler";
import type { INotificationSender } from "../../../../use-cases/interface/output/notificationSender.interface";

export class TelegramBot implements INotificationSender {
  private bot: Bot;

  constructor(
    token: string,
    handler: TelegramAssistantHandler,
    private readonly notificationChatId?: number,
  ) {
    this.bot = new Bot(token);
    handler.register(this.bot);
    if (!notificationChatId) {
      console.warn("TELEGRAM_CHAT_ID not configured — proactive reminders disabled.");
    }
  }

  start(): void {
    this.bot.start();
  }

  stop(): Promise<void> {
    return this.bot.stop();
  }

  async send(text: string): Promise<void> {
    if (!this.notificationChatId) return;
    await this.bot.api.sendMessage(this.notificationChatId, text);
  }
}
```

---

## Phase 7 — NotificationRunner

### 7a. Create `src/adapters/implementations/output/reminder/notificationRunner.ts`

```typescript
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import type { IScheduledNotificationDB } from "../../../../use-cases/interface/output/repository/scheduledNotification.repo";
import type { INotificationSender } from "../../../../use-cases/interface/output/notificationSender.interface";

export class NotificationRunner {
  private isRunning = false;

  constructor(
    private readonly notificationRepo: IScheduledNotificationDB,
    private readonly sender: INotificationSender,
    private readonly pollIntervalMs: number = 60_000,
  ) {}

  start(): void {
    setInterval(() => {
      if (this.isRunning) return;
      this.isRunning = true;
      this.tick()
        .catch((err) => console.error("NotificationRunner tick error:", err))
        .finally(() => { this.isRunning = false; });
    }, this.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    const now = newCurrentUTCEpoch();
    const due = await this.notificationRepo.findDue(now);
    for (const notification of due) {
      try {
        await this.sender.send(
          `Reminder: ${notification.title}\n${notification.body}`,
        );
        await this.notificationRepo.markSent(notification.id, now);
      } catch (err) {
        console.error(`NotificationRunner: failed to send ${notification.id}:`, err);
        await this.notificationRepo.markFailed(notification.id, now);
      }
    }
  }
}
```

---

## Phase 8 — CalendarCrawler

### 8a. Create `src/adapters/implementations/output/reminder/calendarCrawler.ts`

```typescript
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import { CalendarNotConnectedError } from "../../../../helpers/errors/calendarNotConnected.error";
import type { ICalendarService } from "../../../../use-cases/interface/output/calendar.interface";
import type { IScheduledNotificationDB } from "../../../../use-cases/interface/output/repository/scheduledNotification.repo";

const LOOK_AHEAD_SECONDS = 24 * 3600;
const REMINDER_OFFSET_SECONDS = 30 * 60;
const CRAWL_INTERVAL_MS = 30 * 60_000;

export class CalendarCrawler {
  private isRunning = false;

  constructor(
    private readonly calendarService: ICalendarService,
    private readonly notificationRepo: IScheduledNotificationDB,
    private readonly userId: string,
  ) {}

  start(): void {
    this.crawl().catch((err) => console.error("CalendarCrawler initial crawl error:", err));
    setInterval(() => {
      if (this.isRunning) return;
      this.isRunning = true;
      this.crawl()
        .catch((err) => console.error("CalendarCrawler crawl error:", err))
        .finally(() => { this.isRunning = false; });
    }, CRAWL_INTERVAL_MS);
  }

  private async crawl(): Promise<void> {
    const now = newCurrentUTCEpoch();
    const windowEnd = now + LOOK_AHEAD_SECONDS;

    let events;
    try {
      events = await this.calendarService.listEvents(this.userId, {
        startDateTime: new Date(now * 1000).toISOString(),
        endDateTime: new Date(windowEnd * 1000).toISOString(),
        maxResults: 50,
      });
    } catch (err) {
      if (err instanceof CalendarNotConnectedError) return;
      throw err;
    }

    for (const event of events) {
      if (!event.id) continue;

      const startEpoch = Math.floor(
        new Date(event.startDateTime).getTime() / 1000,
      );
      const fireAtEpoch = startEpoch - REMINDER_OFFSET_SECONDS;

      // skip if the reminder window has already passed
      if (fireAtEpoch <= now) continue;

      const existing = await this.notificationRepo.findBySourceId(event.id);
      if (existing) continue;

      const startLabel = new Date(startEpoch * 1000).toUTCString();
      await this.notificationRepo.create({
        id: newUuid(),
        userId: this.userId,
        title: event.summary,
        body: `Starting at ${startLabel}${event.location ? ` — ${event.location}` : ""}`,
        fireAtEpoch,
        status: "pending",
        sourceType: "calendar",
        sourceId: event.id,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });
    }
  }
}
```

---

## Phase 9 — Update CreateTodoItemTool

### 9a. Edit `src/adapters/implementations/output/tools/createTodoItem.ts`

The tool needs to also schedule a notification when it creates a todo item.

**Import changes** — add this import at the top:
```typescript
import type { IScheduledNotificationDB } from "../../../../use-cases/interface/output/repository/scheduledNotification.repo";
```

**Module-level constant** — add after the imports (before the `InputSchema` declaration):
```typescript
const REMINDER_OFFSET_SECONDS = 24 * 3600;
```

**Constructor change** — add a third parameter:
```typescript
constructor(
  private readonly userId: string,
  private readonly todoItemRepo: ITodoItemDB,
  private readonly notificationRepo: IScheduledNotificationDB,
) {}
```

**In `execute()`** — after the `await this.todoItemRepo.create(...)` call, add the notification scheduling logic. Insert this block **immediately after** the `todoItemRepo.create` call, before building the return value:

```typescript
const fireAtEpoch =
  parsed.deadlineEpoch - REMINDER_OFFSET_SECONDS > now
    ? parsed.deadlineEpoch - REMINDER_OFFSET_SECONDS
    : now + 60;

if (fireAtEpoch < parsed.deadlineEpoch) {
  await this.notificationRepo.create({
    id: newUuid(),
    userId: this.userId,
    title: parsed.title,
    body: `Deadline: ${deadlineStr}`,
    fireAtEpoch,
    status: "pending",
    sourceType: "todo",
    sourceId: id,
    createdAtEpoch: now,
    updatedAtEpoch: now,
  });
}
```

Note: `deadlineStr` is declared just above this block. `REMINDER_OFFSET_SECONDS` is now at module scope.

Full updated `execute()` for clarity:

```typescript
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
  const fireAtEpoch =
    parsed.deadlineEpoch - REMINDER_OFFSET_SECONDS > now
      ? parsed.deadlineEpoch - REMINDER_OFFSET_SECONDS
      : now + 60;

  if (fireAtEpoch < parsed.deadlineEpoch) {
    await this.notificationRepo.create({
      id: newUuid(),
      userId: this.userId,
      title: parsed.title,
      body: `Deadline: ${deadlineStr}`,
      fireAtEpoch,
      status: "pending",
      sourceType: "todo",
      sourceId: id,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });
  }

  return {
    success: true,
    data:
      `To-do saved: "${parsed.title}" | Priority: ${parsed.priority} | ` +
      `Deadline: ${deadlineStr} | ID: ${id}`,
  };
}
```

---

## Phase 10 — Update DI container

### 10a. Edit `src/adapters/inject/assistant.di.ts`

**Add these imports** at the top (with the other imports):
```typescript
import { NotificationRunner } from "../implementations/output/reminder/notificationRunner";
import { CalendarCrawler } from "../implementations/output/reminder/calendarCrawler";
import type { INotificationSender } from "../../use-cases/interface/output/notificationSender.interface";
```

**Add a new private field** to the `AssistantInject` class (alongside the existing `_googleOAuthService` field):
```typescript
private _calendarService: GoogleCalendarService | null = null;
```

**Add a new private getter method** to the class (call it before `getUseCase` if you like, but placement does not matter):
```typescript
private getCalendarService(): GoogleCalendarService {
  if (!this._calendarService) {
    const sqlDB = this.getSqlDB();
    this._calendarService = new GoogleCalendarService(
      sqlDB.googleOAuthTokens,
      process.env.GOOGLE_CLIENT_ID ?? "",
      process.env.GOOGLE_CLIENT_SECRET ?? "",
      process.env.GOOGLE_REDIRECT_URI ?? "",
    );
  }
  return this._calendarService;
}
```

**Update `getUseCase()`** — replace the `new GoogleCalendarService(...)` call inside `getUseCase()` with a call to `this.getCalendarService()`:
```typescript
// was:
const calendarService = new GoogleCalendarService(
  sqlDB.googleOAuthTokens,
  process.env.GOOGLE_CLIENT_ID ?? "",
  process.env.GOOGLE_CLIENT_SECRET ?? "",
  process.env.GOOGLE_REDIRECT_URI ?? "",
);
// becomes:
const calendarService = this.getCalendarService();
```

**Update `registryFactory`** inside `getUseCase()`:

Change the `CreateTodoItemTool` registration line from:
```typescript
r.register(new CreateTodoItemTool(userId, sqlDB.todoItems));
```
to:
```typescript
r.register(new CreateTodoItemTool(userId, sqlDB.todoItems, sqlDB.scheduledNotifications));
```

**Add two new public factory methods** to the `AssistantInject` class:

```typescript
getNotificationRunner(sender: INotificationSender): NotificationRunner {
  return new NotificationRunner(
    this.getSqlDB().scheduledNotifications,
    sender,
  );
}

getCalendarCrawler(userId: string): CalendarCrawler {
  return new CalendarCrawler(
    this.getCalendarService(),
    this.getSqlDB().scheduledNotifications,
    userId,
  );
}
```

---

## Phase 11 — Update entry point

### 11a. Edit `src/telegramCli.ts`

Replace the existing `bot` instantiation and then start the runners. The final relevant section of `telegramCli.ts` (from `fixedUserId` onward) becomes:

```typescript
const fixedUserId = process.env.JARVIS_USER_ID ?? process.env.CLI_USER_ID;
const handler = new TelegramAssistantHandler(
  useCase,
  sqlDB.userProfiles,
  googleOAuthService,
  tts,
  fixedUserId,
  token,
);

const notificationChatId = process.env.TELEGRAM_CHAT_ID
  ? parseInt(process.env.TELEGRAM_CHAT_ID, 10)
  : undefined;

const bot = new TelegramBot(token, handler, notificationChatId);

const notificationRunner = inject.getNotificationRunner(bot);
notificationRunner.start();

if (fixedUserId) {
  const calendarCrawler = inject.getCalendarCrawler(fixedUserId);
  calendarCrawler.start();
}

// ... existing oauthServer setup unchanged ...

bot.start();
```

---

## Phase 12 — DB migration

After all code changes:

```bash
npm run db:generate
npm run db:migrate
```

---

## File change summary

| Action | File |
|--------|------|
| EDIT   | `src/adapters/implementations/output/sqlDB/schema.ts` |
| CREATE | `src/use-cases/interface/output/repository/scheduledNotification.repo.ts` |
| CREATE | `src/adapters/implementations/output/sqlDB/repositories/scheduledNotification.repo.ts` |
| EDIT   | `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` |
| CREATE | `src/use-cases/interface/output/notificationSender.interface.ts` |
| EDIT   | `src/adapters/implementations/input/telegram/bot.ts` |
| CREATE | `src/adapters/implementations/output/reminder/notificationRunner.ts` |
| CREATE | `src/adapters/implementations/output/reminder/calendarCrawler.ts` |
| EDIT   | `src/adapters/implementations/output/tools/createTodoItem.ts` |
| EDIT   | `src/adapters/inject/assistant.di.ts` |
| EDIT   | `src/telegramCli.ts` |
| EDIT   | `.env.example` (add `TELEGRAM_CHAT_ID=`) |

**Execution order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12

---

## Behavior summary

- When the LLM calls `CREATE_TODO_ITEM`, a `scheduled_notifications` row is also inserted (24 h before deadline, or ~1 min from now if deadline is within 24 h). If the deadline has already passed when the reminder would fire, no notification is inserted.
- Every 30 minutes, `CalendarCrawler` lists the next 24 h of Google Calendar events and inserts a `pending` notification row for each event not already in the table (deduped by `sourceId = event.id`). Reminder fires 30 min before event start.
- Every 60 seconds, `NotificationRunner` queries for `pending` rows with `fire_at_epoch <= now`, sends each via `bot.api.sendMessage`, and marks them `sent` or `failed`.
- If `TELEGRAM_CHAT_ID` is not set, `NotificationRunner` logs a warning and skips silently — bot startup is not affected.
- If Google Calendar is not connected, `CalendarCrawler` catches `CalendarNotConnectedError` silently and does nothing.
