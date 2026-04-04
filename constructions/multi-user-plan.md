# Multi-User Support Plan

## Goal

Convert JARVIS from a hardcoded single-user system to a proper multi-user system where:
- Only allowlisted Telegram users can interact with the bot
- A designated admin (set via env var) can add/remove users at runtime
- Each user's data (conversations, memories, todos, calendar, Gmail, notifications) is fully isolated
- Background crawlers serve all users, not just one
- Notifications are routed to the correct user's Telegram chat

---

## Pre-Work: Read These Files Before Starting

Read every file listed below in full before writing a single line of code. The plan references exact line numbers that may have shifted.

```
src/adapters/implementations/output/sqlDB/schema.ts
src/use-cases/interface/output/repository/userProfile.repo.ts
src/use-cases/interface/output/repository/scheduledNotification.repo.ts
src/use-cases/interface/output/notificationSender.interface.ts
src/adapters/implementations/output/sqlDB/repositories/userProfile.repo.ts
src/adapters/implementations/output/sqlDB/repositories/scheduledNotification.repo.ts
src/adapters/implementations/output/reminder/notificationRunner.ts
src/adapters/implementations/output/reminder/calendarCrawler.ts
src/adapters/implementations/output/reminder/dailySummaryCrawler.ts
src/adapters/implementations/input/telegram/bot.ts
src/adapters/implementations/input/telegram/handler.ts
src/adapters/inject/assistant.di.ts
src/telegramCli.ts
src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts
```

---

## Conventions (Never Violate)

- IDs: always `newUuid()` from `src/helpers/uuid.ts`, never `crypto.randomUUID()`
- Timestamps: always `newCurrentUTCEpoch()` from `src/helpers/time/dateTime.ts`, never `Date.now()`
- All `*_at_epoch` columns store **seconds**, not milliseconds
- No comments except for unit-conversion quirks, crash-recovery edge cases, or non-obvious performance decisions
- No new files unless the step explicitly says "create new file"
- Run `npm run db:generate && npm run db:migrate` after any schema change before proceeding

---

## Architecture of the Final State

```
Telegram user sends message
  → handler checks allowedTelegramIds table
  → if not allowed: reply "not authorized", stop
  → resolveUserId(chatId) → UUIDv5(chatId, TELEGRAM_NS) [no fixedUserId override]
  → ensure user profile stub exists with telegramChatId stored
  → normal chat/command flow

Admin sends /allow <chatId>
  → handler checks sender == BOT_ADMIN_TELEGRAM_ID
  → inserts chatId into allowed_telegram_ids table

NotificationRunner tick
  → findDue(now) → ScheduledNotification[] (each has userId)
  → for each: look up userProfile.telegramChatId by userId
  → sender.send(text, chatId) → bot.api.sendMessage(chatId, text)

CalendarCrawler tick
  → userProfileRepo.findAll() → for each user: crawl calendar, create notifications
  → notifications are picked up by NotificationRunner (above)

DailySummaryCrawler tick
  → userProfileRepo.findAll() → for each user with wakeUpHour set:
  → check if current UTC hour matches, check dedup sourceId = daily_summary_<userId>_<date>
  → sender.send(summary, user.telegramChatId)
```

---

## Step 1 — Schema: Add `telegram_chat_id` to `user_profiles`

**File:** `src/adapters/implementations/output/sqlDB/schema.ts`

In the `userProfiles` table definition, add one column after `wakeUpHour`:

```typescript
telegramChatId: text("telegram_chat_id"),
```

This stores the user's Telegram numeric chat ID as a string (use `text` not `integer` — Telegram chat IDs can exceed 32-bit int range).

**Guardrail:** Do not add `.notNull()`. Existing rows have no chat ID yet and the column must be nullable.

After this edit, run:
```
npm run db:generate && npm run db:migrate
```

Verify the migration file was created and contains `ALTER TABLE user_profiles ADD COLUMN telegram_chat_id text`.

---

## Step 2 — Schema: Add `allowed_telegram_ids` Table

**File:** `src/adapters/implementations/output/sqlDB/schema.ts`

Add a new table export after the existing `scheduledNotifications` table:

```typescript
export const allowedTelegramIds = pgTable("allowed_telegram_ids", {
  telegramChatId: text("telegram_chat_id").primaryKey(),
  addedAtEpoch: integer("added_at_epoch").notNull(),
});
```

After this edit, run:
```
npm run db:generate && npm run db:migrate
```

Verify the migration contains `CREATE TABLE allowed_telegram_ids`.

---

## Step 3 — Interface: Update `IUserProfile` and `IUserProfileDB`

**File:** `src/use-cases/interface/output/repository/userProfile.repo.ts`

1. Add `telegramChatId: string | null` field to `IUserProfile`.
2. Add `telegramChatId?: string` field to `UserProfileUpsert`.
3. Add two new method signatures to `IUserProfileDB`:
   - `findAll(): Promise<IUserProfile[]>`
   - `findByTelegramChatId(chatId: string): Promise<IUserProfile | null>`

`findFirst()` stays — do not remove it yet (it may still be referenced; removal happens in Step 14).

---

## Step 4 — Interface: New `IAllowedTelegramIdDB`

**Create new file:** `src/use-cases/interface/output/repository/allowedTelegramId.repo.ts`

```typescript
export interface IAllowedTelegramIdDB {
  isAllowed(telegramChatId: string): Promise<boolean>;
  add(telegramChatId: string, addedAtEpoch: number): Promise<void>;
  remove(telegramChatId: string): Promise<void>;
  findAll(): Promise<string[]>;
}
```

---

## Step 5 — Interface: Update `INotificationSender`

**File:** `src/use-cases/interface/output/notificationSender.interface.ts`

Change the `send` signature:

```typescript
// Before
send(text: string): Promise<void>;

// After
send(text: string, telegramChatId: string): Promise<void>;
```

**Guardrail:** After this change, TypeScript will fail on every caller. The compiler errors are your checklist — fix each one as directed in later steps. Do not suppress with `any`.

---

## Step 6 — Repo: Update `DrizzleUserProfileRepo`

**File:** `src/adapters/implementations/output/sqlDB/repositories/userProfile.repo.ts`

### 6a — `upsert`
Add `telegramChatId: profile.telegramChatId ?? null` to both the `.values({...})` block and the `.set({...})` block inside `onConflictDoUpdate`.

### 6b — `findByUserId`
Include `telegramChatId: rows[0].telegramChatId` in the returned object literal.

### 6c — `findFirst`
Include `telegramChatId: rows[0].telegramChatId` in the returned object literal.

### 6d — Implement `findAll`
```typescript
async findAll(): Promise<IUserProfile[]> {
  const rows = await this.db.select().from(userProfiles);
  return rows.map((row) => ({
    userId: row.userId,
    displayName: row.displayName,
    personalities: row.personalities,
    wakeUpHour: row.wakeUpHour,
    telegramChatId: row.telegramChatId,
    createdAtEpoch: row.createdAtEpoch,
    updatedAtEpoch: row.updatedAtEpoch,
  }));
}
```

### 6e — Implement `findByTelegramChatId`
```typescript
async findByTelegramChatId(chatId: string): Promise<IUserProfile | null> {
  const rows = await this.db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.telegramChatId, chatId))
    .limit(1);
  if (!rows[0]) return null;
  return {
    userId: rows[0].userId,
    displayName: rows[0].displayName,
    personalities: rows[0].personalities,
    wakeUpHour: rows[0].wakeUpHour,
    telegramChatId: rows[0].telegramChatId,
    createdAtEpoch: rows[0].createdAtEpoch,
    updatedAtEpoch: rows[0].updatedAtEpoch,
  };
}
```

---

## Step 7 — Repo: Create `DrizzleAllowedTelegramIdRepo`

**Create new file:** `src/adapters/implementations/output/sqlDB/repositories/allowedTelegramId.repo.ts`

Implement `IAllowedTelegramIdDB` using the `allowedTelegramIds` table from schema.

- `isAllowed`: select where `telegramChatId = chatId`, return `rows.length > 0`
- `add`: insert `{ telegramChatId, addedAtEpoch }` — use `onConflictDoNothing()` so duplicate adds are idempotent
- `remove`: delete where `telegramChatId = chatId`
- `findAll`: select all, return `rows.map(r => r.telegramChatId)`

Use `newCurrentUTCEpoch()` for `addedAtEpoch` inside the `add` implementation. Do not accept it as a parameter from outside.

---

## Step 8 — Adapter: Register New Repo in `DrizzleSqlDB`

**File:** `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts`

1. Import `DrizzleAllowedTelegramIdRepo` and `allowedTelegramIds` (the schema table).
2. Add a public property: `allowedTelegramIds: DrizzleAllowedTelegramIdRepo`.
3. In the constructor, instantiate it: `this.allowedTelegramIds = new DrizzleAllowedTelegramIdRepo(db)`.

---

## Step 9 — Update `TelegramBot.send()`

**File:** `src/adapters/implementations/input/telegram/bot.ts`

### 9a — Remove `notificationChatId` from constructor
Delete the `private readonly notificationChatId?: number` constructor parameter and the `if (!notificationChatId)` warn block.

### 9b — Update `send`
```typescript
async send(text: string, telegramChatId: string): Promise<void> {
  await this.bot.api.sendMessage(parseInt(telegramChatId, 10), text);
}
```

No guard needed — callers are responsible for only calling `send` when they have a valid `telegramChatId`.

**Guardrail:** `telegramChatId` is stored as `text` in the DB but Telegram's API requires a number. Always parse with `parseInt(telegramChatId, 10)`. Never use `Number()` as it silently mishandles non-numeric strings differently.

---

## Step 10 — Update `NotificationRunner`

**File:** `src/adapters/implementations/output/reminder/notificationRunner.ts`

### 10a — Add dependency
Add `private readonly userProfileRepo: IUserProfileDB` to the constructor. Import the interface.

### 10b — Update `tick`
```typescript
private async tick(): Promise<void> {
  const now = newCurrentUTCEpoch();
  const due = await this.notificationRepo.findDue(now);
  for (const notification of due) {
    const profile = await this.userProfileRepo.findByUserId(notification.userId);
    if (!profile?.telegramChatId) {
      await this.notificationRepo.markFailed(notification.id, now);
      continue;
    }
    try {
      await this.sender.send(
        `Reminder: ${notification.title}\n${notification.body}`,
        profile.telegramChatId,
      );
      await this.notificationRepo.markSent(notification.id, now);
    } catch (err) {
      console.error(`NotificationRunner: failed to send ${notification.id}:`, err);
      await this.notificationRepo.markFailed(notification.id, now);
    }
  }
}
```

**Guardrail:** If `telegramChatId` is null (user set up via DB directly without a Telegram profile), mark as failed rather than silently skipping — this surfaces the misconfiguration in the DB log.

---

## Step 11 — Update `CalendarCrawler` to Loop All Users

**File:** `src/adapters/implementations/output/reminder/calendarCrawler.ts`

### 11a — Change constructor
Remove `private readonly userId: string`. Add `private readonly userProfileRepo: IUserProfileDB`. Import the interface.

### 11b — Update `crawl`
Wrap the existing logic in a loop over all users:

```typescript
private async crawl(): Promise<void> {
  const users = await this.userProfileRepo.findAll();
  for (const user of users) {
    await this.crawlForUser(user.userId);
  }
}
```

Extract the existing body of `crawl()` into `private async crawlForUser(userId: string): Promise<void>`, replacing all `this.userId` references with the `userId` parameter.

**Guardrail:** Errors in one user's crawl must not stop others. Wrap the `crawlForUser` call:
```typescript
await this.crawlForUser(user.userId).catch((err) =>
  console.error(`CalendarCrawler: error for user ${user.userId}:`, err),
);
```

---

## Step 12 — Update `DailySummaryCrawler` to Loop All Users

**File:** `src/adapters/implementations/output/reminder/dailySummaryCrawler.ts`

### 12a — Change constructor
Remove `private readonly userId: string`. Keep `private readonly userProfileRepo: IUserProfileDB` (it already exists). Keep all other dependencies.

### 12b — Fix dedup `sourceId` bug
The current `dedupId` is `daily_summary_${todayKey}` — this is global across all users. Two users with the same wake-up time would collide. Change it to `daily_summary_${userId}_${todayKey}`.

### 12c — Update `tick`
```typescript
private async tick(): Promise<void> {
  const users = await this.userProfileRepo.findAll();
  for (const user of users) {
    await this.tickForUser(user).catch((err) =>
      console.error(`DailySummaryCrawler: error for user ${user.userId}:`, err),
    );
  }
}
```

Extract the existing body of `tick()` into `private async tickForUser(user: IUserProfile): Promise<void>`.

In `tickForUser`:
- Replace `this.userId` with `user.userId`
- Replace `await this.userProfileRepo.findByUserId(this.userId)` lookup with direct use of the passed `user` object (it's already the profile)
- Fix `dedupId` to `daily_summary_${user.userId}_${todayKey}`
- Fix `sender.send(...)` call: `await this.sender.send(lines.join("\n"), user.telegramChatId!)` — skip the send if `user.telegramChatId` is null (guard: `if (!user.telegramChatId) return;` before the send)

---

## Step 13 — Update `TelegramAssistantHandler`

**File:** `src/adapters/implementations/input/telegram/handler.ts`

### 13a — Update constructor
Remove `private readonly fixedUserId?: string`.
Add:
```typescript
private readonly allowedTelegramIds: IAllowedTelegramIdDB,
private readonly adminChatId: number | undefined,
```
Import `IAllowedTelegramIdDB`.

### 13b — Fix `resolveUserId`
Remove the `fixedUserId ??` fallback. The method becomes:
```typescript
private resolveUserId(chatId: number): string {
  return uuidV5(String(chatId), TELEGRAM_NS);
}
```

### 13c — Add access guard helper
```typescript
private async isAllowed(chatId: number): Promise<boolean> {
  return this.allowedTelegramIds.isAllowed(String(chatId));
}
```

### 13d — Add access check to every inbound handler
At the top of every `bot.on(...)` and `bot.command(...)` handler body (except `/start` and admin commands), add:
```typescript
if (!(await this.isAllowed(ctx.chat.id))) {
  await ctx.reply("You are not authorized to use this bot.");
  return;
}
```

The handlers that need this guard:
- `bot.command("new", ...)`
- `bot.command("history", ...)`
- `bot.command("setup", ...)`
- `bot.command("code", ...)`
- `bot.command("speech", ...)`
- `bot.on("message:voice", ...)`
- `bot.on("message:photo", ...)`
- `bot.on("message:text", ...)`

### 13e — Update `/start` handler
`/start` should be usable by anyone (so they know the bot exists), but the reply should differ based on access:
```typescript
bot.command("start", async (ctx) => {
  if (!(await this.isAllowed(ctx.chat.id))) {
    await ctx.reply("You are not authorized to use this bot. Contact the administrator.");
    return;
  }
  await ctx.reply("JARVIS online. Send me a message.\n\nRun /setup to personalize your experience.");
});
```

### 13f — Add `/allow` and `/revoke` admin commands
```typescript
bot.command("allow", async (ctx) => {
  if (!this.adminChatId || ctx.chat.id !== this.adminChatId) return;
  const targetId = ctx.match?.trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    await ctx.reply("Usage: /allow <telegramChatId>");
    return;
  }
  await this.allowedTelegramIds.add(targetId, newCurrentUTCEpoch());
  await ctx.reply(`Allowed: ${targetId}`);
});

bot.command("revoke", async (ctx) => {
  if (!this.adminChatId || ctx.chat.id !== this.adminChatId) return;
  const targetId = ctx.match?.trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    await ctx.reply("Usage: /revoke <telegramChatId>");
    return;
  }
  await this.allowedTelegramIds.remove(targetId);
  await ctx.reply(`Revoked: ${targetId}`);
});
```

Import `newCurrentUTCEpoch` from `../../../../helpers/time/dateTime`.

### 13g — Auto-provision user profile stub on first allowed contact
Add a private helper:
```typescript
private async ensureUserProfile(userId: string, chatId: number): Promise<void> {
  const existing = await this.userProfileRepo.findByUserId(userId);
  if (!existing) {
    await this.userProfileRepo.upsert({
      userId,
      personalities: [],
      wakeUpHour: null,
      telegramChatId: String(chatId),
    });
  } else if (!existing.telegramChatId) {
    await this.userProfileRepo.upsert({
      userId,
      personalities: existing.personalities,
      wakeUpHour: existing.wakeUpHour,
      telegramChatId: String(chatId),
    });
  }
}
```

Call `await this.ensureUserProfile(userId, ctx.chat.id)` in each handler **after** the access check and **after** calling `resolveUserId`, before dispatching to the use case. Do this in:
- `message:text`
- `message:voice`
- `message:photo`
- `/speech`

Not needed in `/history`, `/new`, `/code` — those don't create new users.

Also update `/setup` completion (in `handleSetupReply`, the wakeup phase): include `telegramChatId: String(chatId)` in the `upsert` call so the profile always records the chat ID.

---

## Step 14 — Update `AssistantInject`

**File:** `src/adapters/inject/assistant.di.ts`

### 14a — Remove `resolveUserId`
Delete the entire `resolveUserId()` method (lines 182–187 currently). It will no longer be called.

### 14b — Update `getNotificationRunner`
Add `IUserProfileDB` parameter to the signature, pass it to `NotificationRunner` constructor:
```typescript
getNotificationRunner(sender: INotificationSender): NotificationRunner {
  return new NotificationRunner(
    this.getSqlDB().scheduledNotifications,
    this.getSqlDB().userProfiles,
    sender,
  );
}
```

### 14c — Update `getCalendarCrawler`
Remove `userId: string` parameter. Pass `userProfileRepo` instead:
```typescript
getCalendarCrawler(): CalendarCrawler {
  const offsetMins = parseInt(
    process.env.CALENDAR_REMINDER_OFFSET_MINS ?? "30",
    10,
  );
  return new CalendarCrawler(
    this.getCalendarService(),
    this.getSqlDB().scheduledNotifications,
    this.getSqlDB().userProfiles,
    offsetMins * 60,
  );
}
```

### 14d — Update `getDailySummaryCrawler`
Remove `userId: string` parameter:
```typescript
getDailySummaryCrawler(sender: INotificationSender): DailySummaryCrawler {
  return new DailySummaryCrawler(
    this.getCalendarService(),
    this.getSqlDB().scheduledNotifications,
    this.getSqlDB().userProfiles,
    sender,
  );
}
```

---

## Step 15 — Update `telegramCli.ts`

**File:** `src/telegramCli.ts`

### 15a — Remove `fixedUserId` entirely
Delete lines:
```typescript
const fixedUserId = await inject.resolveUserId();
if (!fixedUserId) { ... }
```

### 15b — Remove `TELEGRAM_CHAT_ID` env var usage
Delete:
```typescript
const notificationChatId = process.env.TELEGRAM_CHAT_ID
  ? parseInt(process.env.TELEGRAM_CHAT_ID, 10)
  : undefined;
```

### 15c — Update `TelegramBot` instantiation
Remove the third argument (`notificationChatId`):
```typescript
const bot = new TelegramBot(token, handler);
```

### 15d — Read admin chat ID
```typescript
const adminChatId = process.env.BOT_ADMIN_TELEGRAM_ID
  ? parseInt(process.env.BOT_ADMIN_TELEGRAM_ID, 10)
  : undefined;
```

### 15e — Update `TelegramAssistantHandler` instantiation
```typescript
const handler = new TelegramAssistantHandler(
  useCase,
  sqlDB.userProfiles,
  googleOAuthService,
  tts,
  sqlDB.allowedTelegramIds,
  adminChatId,
  token,
);
```

Note: `fixedUserId` argument is removed; `allowedTelegramIds` and `adminChatId` are new; order must match the updated constructor signature from Step 13a.

### 15f — Update crawler startup
```typescript
inject.getCalendarCrawler().start();
inject.getDailySummaryCrawler(bot).start();
```

Remove the `if (fixedUserId)` guard — crawlers now handle the case where no users exist (they call `findAll()` which returns `[]`).

---

## Step 16 — Update `.env.example`

**File:** `.env.example` (read it first to see current contents)

- Remove: `JARVIS_USER_ID`, `CLI_USER_ID`, `TELEGRAM_CHAT_ID`
- Add:
```
# Telegram chat ID of the bot admin (can run /allow and /revoke commands)
BOT_ADMIN_TELEGRAM_ID=
```

---

## Step 17 — Bootstrap: Seed the Admin's Chat ID

The admin must be in `allowed_telegram_ids` to use the bot at all. Since `/allow` is only usable by the admin, the admin's own chat ID must be seeded directly.

Add an instruction comment in `.env.example` (or a `SETUP.md` if one exists) explaining:

> After first run, seed the admin's own Telegram chat ID into the DB:
> ```sql
> INSERT INTO allowed_telegram_ids (telegram_chat_id, added_at_epoch)
> VALUES ('<your_telegram_chat_id>', EXTRACT(EPOCH FROM NOW())::integer)
> ON CONFLICT DO NOTHING;
> ```
> After that, the admin can use `/allow <chatId>` in Telegram to add other users.

---

## Step 18 — TypeScript Compile Check

After all steps are complete, run:
```
npx tsc --noEmit
```

Fix every error before considering the implementation done. Common errors that will appear:
- `send()` called with wrong number of arguments — fix each call site
- `TelegramAssistantHandler` constructor argument count mismatch
- `CalendarCrawler` / `DailySummaryCrawler` constructor argument mismatch
- Missing `telegramChatId` in object literals that construct `IUserProfile`

Do not suppress errors with `as any` or `@ts-ignore`.

---

## Step 19 — Manual Smoke Test Checklist

After TypeScript compiles cleanly:

1. **Unauthorized user:** Send a message from a Telegram account NOT in `allowed_telegram_ids`. Expect: "You are not authorized to use this bot."

2. **Admin allows a user:** Admin sends `/allow <chatId>`. Verify row appears in `allowed_telegram_ids` table.

3. **Authorized user onboarding:** Allowed user sends any message. Verify `user_profiles` row is created with their `telegram_chat_id` populated.

4. **Setup flow:** Allowed user runs `/setup`, completes all 6 questions + wake-up hour. Verify `user_profiles` row updated with personalities and `wake_up_hour`.

5. **Data isolation:** Two allowed users each send a message. Verify separate `conversations` rows with different `user_id` values.

6. **Notification routing:** Create a calendar event for user A within 24h. Wait for CalendarCrawler tick. Verify `scheduled_notifications` row has user A's `user_id`. Wait for NotificationRunner tick. Verify Telegram message arrives in user A's chat, NOT user B's.

7. **Revoke:** Admin sends `/revoke <chatId>`. Verify row removed from `allowed_telegram_ids`. Revoked user's next message gets "not authorized".

8. **Admin self-bootstrap:** Confirm admin's own chat ID is in `allowed_telegram_ids` (seeded in Step 17). Admin can use normal chat and admin commands.

---

## Files Changed Summary

| File | Type of Change |
|------|---------------|
| `src/adapters/implementations/output/sqlDB/schema.ts` | Add `telegramChatId` column to `userProfiles`; add `allowedTelegramIds` table |
| `src/use-cases/interface/output/repository/userProfile.repo.ts` | Add `telegramChatId` to types; add `findAll`, `findByTelegramChatId` methods |
| `src/use-cases/interface/output/repository/allowedTelegramId.repo.ts` | **New file** — `IAllowedTelegramIdDB` interface |
| `src/use-cases/interface/output/notificationSender.interface.ts` | Add `telegramChatId: string` param to `send()` |
| `src/adapters/implementations/output/sqlDB/repositories/userProfile.repo.ts` | Implement `findAll`, `findByTelegramChatId`; propagate `telegramChatId` |
| `src/adapters/implementations/output/sqlDB/repositories/allowedTelegramId.repo.ts` | **New file** — Drizzle implementation |
| `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` | Add `allowedTelegramIds` property |
| `src/adapters/implementations/input/telegram/bot.ts` | Remove `notificationChatId`; update `send()` signature |
| `src/adapters/implementations/output/reminder/notificationRunner.ts` | Add `userProfileRepo` dep; route notifications by `telegramChatId` |
| `src/adapters/implementations/output/reminder/calendarCrawler.ts` | Replace `userId` with `userProfileRepo`; loop all users |
| `src/adapters/implementations/output/reminder/dailySummaryCrawler.ts` | Replace `userId` with loop; fix dedup sourceId; update `send()` call |
| `src/adapters/implementations/input/telegram/handler.ts` | Remove `fixedUserId`; add allowlist check; add `/allow`, `/revoke`; auto-provision profiles |
| `src/adapters/inject/assistant.di.ts` | Remove `resolveUserId()`; update crawler/runner factory methods |
| `src/telegramCli.ts` | Remove `fixedUserId`, `TELEGRAM_CHAT_ID`; add `BOT_ADMIN_TELEGRAM_ID`; update instantiation |
| `.env.example` | Remove old vars; add `BOT_ADMIN_TELEGRAM_ID` |

---

## What Stays Unchanged

These are already multi-user-correct and must not be touched:

- `src/use-cases/implementations/assistant.usecase.ts` — already accepts `userId` per request
- `src/adapters/inject/assistant.di.ts` — `registryFactory(userId)` already correct
- All tool implementations — already accept `userId` in constructor
- `src/adapters/implementations/output/googleOAuth/googleOAuth.service.ts` — per-user token storage already correct
- All other repositories — already query by `userId`
- DB schema tables other than `userProfiles` — already have `userId` columns
