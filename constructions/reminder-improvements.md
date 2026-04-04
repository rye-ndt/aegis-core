# Reminder Improvements — Implementation Plan

## Overview

Three improvements to the proactive reminders system built in `proactive-reminders.md`:

1. **Configurable reminder offsets** — hardcoded `24h` (todo) and `30min` (calendar) offsets moved to `.env`
2. **Daily summary** — new `DailySummaryCrawler` sends a day-at-a-glance calendar message at the user's wake-up hour
3. **Auto-resolve userId from DB** — removes `JARVIS_USER_ID` env var; system queries `user_profiles` to discover the single user instead

**Execution order:** Steps 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

**Guardrails:**
- Never use `crypto.randomUUID()` or `Date.now()` directly — use `newUuid()` / `newCurrentUTCEpoch()` helpers
- All `*_at_epoch` columns store seconds, not milliseconds
- No new DB tables needed
- Do not touch `ISqlDB` — add methods only to `IUserProfileDB` and its Drizzle implementation
- Do not add JSDoc, explanatory comments, or section dividers
- Run `npm run db:generate && npm run db:migrate` only if schema changes occur (none in this plan)
- TypeScript strict mode — no `any`, no `!` non-null assertions unless the value was verified one line above

---

## Step 1 — Add env vars to `.env.example`

**File:** `.env.example`

Add these three lines after `TELEGRAM_CHAT_ID=...` and before `JARVIS_USER_ID=...`:

```
# Minutes before a calendar event to fire its reminder (default: 30)
CALENDAR_REMINDER_OFFSET_MINS=30

# Hours before a todo deadline to fire its reminder (default: 24)
TODO_REMINDER_OFFSET_HOURS=24
```

Remove the `JARVIS_USER_ID=...` line entirely — it will be replaced by DB auto-discovery in Step 7.

---

## Step 2 — Thread configurable offsets into `CalendarCrawler`

**File:** `src/adapters/implementations/output/reminder/calendarCrawler.ts`

Replace the two hardcoded module-level constants:

```typescript
// before
const LOOK_AHEAD_SECONDS = 24 * 3600;
const REMINDER_OFFSET_SECONDS = 30 * 60;
```

with a single module-level constant for the look-ahead window (this one is not user-configurable, it is an internal crawl behaviour):

```typescript
const LOOK_AHEAD_SECONDS = 24 * 3600;
```

Add `reminderOffsetSeconds` as a constructor parameter (fourth parameter, after `userId`):

```typescript
constructor(
  private readonly calendarService: ICalendarService,
  private readonly notificationRepo: IScheduledNotificationDB,
  private readonly userId: string,
  private readonly reminderOffsetSeconds: number,
) {}
```

In `crawl()`, replace the hardcoded constant reference with the instance field:

```typescript
// before
const fireAtEpoch = startEpoch - REMINDER_OFFSET_SECONDS;
// after
const fireAtEpoch = startEpoch - this.reminderOffsetSeconds;
```

No other changes.

---

## Step 3 — Thread configurable offset into `CreateTodoItemTool`

**File:** `src/adapters/implementations/output/tools/createTodoItem.ts`

Remove the module-level constant:

```typescript
// remove this line
const REMINDER_OFFSET_SECONDS = 24 * 3600;
```

Add `reminderOffsetSeconds` as a fourth constructor parameter:

```typescript
constructor(
  private readonly userId: string,
  private readonly todoItemRepo: ITodoItemDB,
  private readonly notificationRepo: IScheduledNotificationDB,
  private readonly reminderOffsetSeconds: number,
) {}
```

In `execute()`, replace every reference to `REMINDER_OFFSET_SECONDS` with `this.reminderOffsetSeconds`. There are two occurrences — the `fireAtEpoch` calculation and the guard condition `if (fireAtEpoch < parsed.deadlineEpoch)`:

```typescript
// before (both occurrences)
parsed.deadlineEpoch - REMINDER_OFFSET_SECONDS
// after
parsed.deadlineEpoch - this.reminderOffsetSeconds
```

---

## Step 4 — Add `findFirst` to `IUserProfileDB` and its implementation

### 4a. Interface

**File:** `src/use-cases/interface/output/repository/userProfile.repo.ts`

Add one method to `IUserProfileDB`:

```typescript
export interface IUserProfileDB {
  upsert(profile: UserProfileUpsert): Promise<void>;
  findByUserId(userId: string): Promise<IUserProfile | null>;
  findFirst(): Promise<IUserProfile | null>;
}
```

### 4b. Implementation

**File:** `src/adapters/implementations/output/sqlDB/repositories/userProfile.repo.ts`

Add the following method to `DrizzleUserProfileRepo` (after `findByUserId`):

```typescript
async findFirst(): Promise<IUserProfile | null> {
  const rows = await this.db
    .select()
    .from(userProfiles)
    .orderBy(userProfiles.createdAtEpoch)
    .limit(1);

  if (!rows[0]) return null;
  return {
    userId: rows[0].userId,
    displayName: rows[0].displayName,
    personalities: rows[0].personalities,
    wakeUpHour: rows[0].wakeUpHour,
    createdAtEpoch: rows[0].createdAtEpoch,
    updatedAtEpoch: rows[0].updatedAtEpoch,
  };
}
```

Add `orderBy` to the drizzle-orm import at the top of this file:

```typescript
import { eq, orderBy } from "drizzle-orm";
```

Wait — `orderBy` is not imported from `drizzle-orm`; it is used as a query builder method. The column reference `userProfiles.createdAtEpoch` is already available. The `asc` function must be imported:

```typescript
import { asc, eq } from "drizzle-orm";
```

Then use:

```typescript
.orderBy(asc(userProfiles.createdAtEpoch))
```

---

## Step 5 — Create `DailySummaryCrawler`

**File:** `src/adapters/implementations/output/reminder/dailySummaryCrawler.ts`  
(new file — create it)

### Design

- Runs a `setInterval` every 5 minutes
- On each tick, reads the user's `wakeUpHour` from `IUserProfileDB`
- Checks if the current UTC hour equals `wakeUpHour`
- Checks if a summary for today has already been sent by looking for a `scheduled_notifications` row with `sourceId = "daily_summary_YYYY-MM-DD"` (where the date is today in UTC)
- If not yet sent: fetches today's calendar events, composes a message, sends it via `INotificationSender`, then inserts a dedup row into `scheduled_notifications` with `status = "sent"` so it won't fire again today
- If Google Calendar is not connected, catches `CalendarNotConnectedError` silently and does not insert the dedup row (so it will retry next hour)
- If `wakeUpHour` is `null` (user hasn't completed `/setup`), skips silently

### Full file content

```typescript
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import { CalendarNotConnectedError } from "../../../../helpers/errors/calendarNotConnected.error";
import type { ICalendarService } from "../../../../use-cases/interface/output/calendar.interface";
import type { IScheduledNotificationDB } from "../../../../use-cases/interface/output/repository/scheduledNotification.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { INotificationSender } from "../../../../use-cases/interface/output/notificationSender.interface";

const CHECK_INTERVAL_MS = 5 * 60_000;

export class DailySummaryCrawler {
  private isRunning = false;

  constructor(
    private readonly calendarService: ICalendarService,
    private readonly notificationRepo: IScheduledNotificationDB,
    private readonly userProfileRepo: IUserProfileDB,
    private readonly sender: INotificationSender,
    private readonly userId: string,
  ) {}

  start(): void {
    setInterval(() => {
      if (this.isRunning) return;
      this.isRunning = true;
      this.tick()
        .catch((err) => console.error("DailySummaryCrawler tick error:", err))
        .finally(() => {
          this.isRunning = false;
        });
    }, CHECK_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    const profile = await this.userProfileRepo.findByUserId(this.userId);
    if (!profile || profile.wakeUpHour === null) return;

    const now = newCurrentUTCEpoch();
    const nowDate = new Date(now * 1000);
    const currentHourUTC = nowDate.getUTCHours();

    if (currentHourUTC !== profile.wakeUpHour) return;

    const todayKey = nowDate.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const dedupId = `daily_summary_${todayKey}`;

    const existing = await this.notificationRepo.findBySourceId(dedupId);
    if (existing) return;

    const startOfDay = new Date(`${todayKey}T00:00:00.000Z`);
    const endOfDay = new Date(`${todayKey}T23:59:59.999Z`);

    let events;
    try {
      events = await this.calendarService.listEvents(this.userId, {
        startDateTime: startOfDay.toISOString(),
        endDateTime: endOfDay.toISOString(),
        maxResults: 50,
      });
    } catch (err) {
      if (err instanceof CalendarNotConnectedError) return;
      throw err;
    }

    const lines: string[] = [`Good morning! Here's your day for ${todayKey}:`];

    if (events.length === 0) {
      lines.push("No events scheduled today.");
    } else {
      for (const event of events) {
        const startLabel = new Date(event.startDateTime).toUTCString();
        const location = event.location ? ` @ ${event.location}` : "";
        lines.push(`• ${event.summary} — ${startLabel}${location}`);
      }
    }

    await this.sender.send(lines.join("\n"));

    await this.notificationRepo.create({
      id: newUuid(),
      userId: this.userId,
      title: "Daily summary",
      body: dedupId,
      fireAtEpoch: now,
      status: "sent",
      sourceType: "daily_summary",
      sourceId: dedupId,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });
  }
}
```

### Domain type update

**File:** `src/use-cases/interface/output/repository/scheduledNotification.repo.ts`

Add `"daily_summary"` to `NotificationSourceType`:

```typescript
// before
export type NotificationSourceType = "todo" | "calendar";
// after
export type NotificationSourceType = "todo" | "calendar" | "daily_summary";
```

---

## Step 6 — Wire `DailySummaryCrawler` into `AssistantInject`

**File:** `src/adapters/inject/assistant.di.ts`

### 6a. Add import

Add to the import block (alongside `NotificationRunner` and `CalendarCrawler`):

```typescript
import { DailySummaryCrawler } from "../implementations/output/reminder/dailySummaryCrawler";
```

### 6b. Add `resolveUserId` method

Add this public async method to the `AssistantInject` class. It checks the env var first for backward compatibility, then falls back to the first profile in the DB:

```typescript
async resolveUserId(): Promise<string | undefined> {
  const fromEnv = process.env.JARVIS_USER_ID ?? process.env.CLI_USER_ID;
  if (fromEnv) return fromEnv;
  const profile = await this.getSqlDB().userProfiles.findFirst();
  return profile?.userId;
}
```

### 6c. Add `getDailySummaryCrawler` factory method

Add alongside `getCalendarCrawler`:

```typescript
getDailySummaryCrawler(userId: string, sender: INotificationSender): DailySummaryCrawler {
  return new DailySummaryCrawler(
    this.getCalendarService(),
    this.getSqlDB().scheduledNotifications,
    this.getSqlDB().userProfiles,
    sender,
    userId,
  );
}
```

### 6d. Update `getCalendarCrawler` to pass offset

**Current signature:**

```typescript
getCalendarCrawler(userId: string): CalendarCrawler {
  return new CalendarCrawler(
    this.getCalendarService(),
    this.getSqlDB().scheduledNotifications,
    userId,
  );
}
```

**Updated:**

```typescript
getCalendarCrawler(userId: string): CalendarCrawler {
  const offsetMins = parseInt(process.env.CALENDAR_REMINDER_OFFSET_MINS ?? "30", 10);
  return new CalendarCrawler(
    this.getCalendarService(),
    this.getSqlDB().scheduledNotifications,
    userId,
    offsetMins * 60,
  );
}
```

### 6e. Update `registryFactory` in `getUseCase()` for `CreateTodoItemTool`

Find the existing line registering `CreateTodoItemTool`:

```typescript
r.register(
  new CreateTodoItemTool(
    userId,
    sqlDB.todoItems,
    sqlDB.scheduledNotifications,
  ),
);
```

Replace with:

```typescript
const todoReminderOffsetSecs = parseInt(
  process.env.TODO_REMINDER_OFFSET_HOURS ?? "24",
  10,
) * 3600;
r.register(
  new CreateTodoItemTool(
    userId,
    sqlDB.todoItems,
    sqlDB.scheduledNotifications,
    todoReminderOffsetSecs,
  ),
);
```

Note: the `parseInt` line should be **outside** the `registryFactory` closure (before it is defined) since the env var doesn't change per request. Move it to just before `const registryFactory = (userId: string): IToolRegistry => {`.

---

## Step 7 — Update `telegramCli.ts` entry point

**File:** `src/telegramCli.ts`

Wrap the entire startup body in a top-level `async` IIFE so `resolveUserId()` can be awaited. The current file is not async at the top level.

### Full replacement of `src/telegramCli.ts`

```typescript
import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import { AssistantInject } from "./adapters/inject/assistant.di";
import { TelegramBot } from "./adapters/implementations/input/telegram/bot";
import { TelegramAssistantHandler } from "./adapters/implementations/input/telegram/handler";

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set.");
    process.exit(1);
  }

  const inject = new AssistantInject();
  const useCase = inject.getUseCase();
  const sqlDB = inject.getSqlDB();
  const googleOAuthService = inject.getGoogleOAuthService();
  const tts = inject.getTTS();

  const fixedUserId = await inject.resolveUserId();

  if (!fixedUserId) {
    console.warn(
      "No user profile found in DB and JARVIS_USER_ID is not set. " +
      "Proactive crawlers will not start. Run /setup in Telegram first.",
    );
  }

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
    inject.getCalendarCrawler(fixedUserId).start();
    inject.getDailySummaryCrawler(fixedUserId, bot).start();
  }

  const oauthPort = parseInt(process.env.OAUTH_CALLBACK_PORT ?? "3000", 10);

  const oauthServer = http.createServer(async (req, res) => {
    const base = `http://localhost:${oauthPort}`;
    const url = new URL(req.url ?? "/", base);

    if (url.pathname !== "/api/auth/google/calendar/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const userId = url.searchParams.get("state");

    if (!code || !userId) {
      res.writeHead(400);
      res.end("Missing code or state parameter.");
      return;
    }

    try {
      await googleOAuthService.handleCallback(code, userId);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html>
          <body>
            <h2>Authorization complete.</h2>
            <p>Return to Telegram — you're all set.</p>
          </body>
        </html>`,
      );
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.writeHead(500);
      res.end("Authorization failed. The code may be expired. Try /setup again.");
    }
  });

  oauthServer.listen(oauthPort, () => {
    console.log(`OAuth callback server listening on port ${oauthPort}`);
  });

  console.log("JARVIS Telegram is up and running.");

  process.on("SIGINT", async () => {
    console.log("\nShutting down…");
    oauthServer.close();
    await bot.stop();
    process.exit(0);
  });

  bot.start();
})();
```

---

## Step 8 — Verify TypeScript compiles

After all edits, run:

```bash
npm run build
```

Fix any type errors before considering the implementation complete. Common issues to watch for:
- `orderBy` / `asc` import missing in `userProfile.repo.ts`
- `DailySummaryCrawler` constructor argument count mismatch
- `resolveUserId` return type (`string | undefined`) matching `fixedUserId?: string` parameter in `TelegramAssistantHandler`

---

## File change summary

| Action | File |
|--------|------|
| EDIT   | `.env.example` |
| EDIT   | `src/adapters/implementations/output/reminder/calendarCrawler.ts` |
| EDIT   | `src/adapters/implementations/output/tools/createTodoItem.ts` |
| EDIT   | `src/use-cases/interface/output/repository/userProfile.repo.ts` |
| EDIT   | `src/adapters/implementations/output/sqlDB/repositories/userProfile.repo.ts` |
| EDIT   | `src/use-cases/interface/output/repository/scheduledNotification.repo.ts` |
| CREATE | `src/adapters/implementations/output/reminder/dailySummaryCrawler.ts` |
| EDIT   | `src/adapters/inject/assistant.di.ts` |
| EDIT   | `src/telegramCli.ts` |

**No DB migrations needed** — no schema changes.

---

## Behavior summary

### Configurable offsets
- `CALENDAR_REMINDER_OFFSET_MINS=30` — calendar event reminder fires N minutes before event start. Parsed in `AssistantInject.getCalendarCrawler()`, passed as `reminderOffsetSeconds = N * 60`.
- `TODO_REMINDER_OFFSET_HOURS=24` — todo reminder fires N hours before deadline. Parsed in `AssistantInject.getUseCase()` outside the `registryFactory` closure, passed as `reminderOffsetSeconds = N * 3600`.

### Daily summary
- Every 5 minutes, `DailySummaryCrawler.tick()` runs
- If `currentHourUTC === profile.wakeUpHour` and no `daily_summary_YYYY-MM-DD` row exists in `scheduled_notifications`, it fetches today's events, sends a Telegram message, and inserts a `status="sent"` dedup row
- If Google Calendar is not connected, the dedup row is NOT inserted — the crawler will retry at the next hour match (next day)
- If `wakeUpHour` is null, skips silently

### Auto userId resolution
- `JARVIS_USER_ID` env var removed from `.env.example`
- At startup, `inject.resolveUserId()` checks `JARVIS_USER_ID` / `CLI_USER_ID` env vars first (backward-compatible)
- If neither is set, queries `user_profiles` for the earliest-created profile
- If no profile exists, crawlers don't start and a warning is logged — normal message handling still works (handler derives userId from Telegram chat ID)
