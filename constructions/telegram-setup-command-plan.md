# Telegram `/setup` Command Plan

## Goal

Add a `/setup` command to the Telegram bot that walks the user through a wizard to:
1. Customize JARVIS's personality traits via guided questions
2. Capture their wake-up hour (used later for task reminders)
3. Authorize Google Calendar + Gmail via an OAuth link

---

## Why a Wizard (Not a Single Form)

Users don't know how to describe an AI agent's traits in abstract terms. The wizard breaks it down into concrete, binary-choice questions. Each answer maps to one or more values in the `PERSONALITIES` enum. The user just picks `a` or `b` — no knowledge of the system needed.

---

## Architecture Overview

```
Telegram handler
  ↳ /setup command → starts SetupSession (state machine)
  ↳ subsequent text messages → routed through SetupSession if active

SetupSession (per chatId, in-memory)
  ↳ step index + accumulated answers

On completion:
  ↳ IUserProfileDB.upsert(userId, { personalities, wakeUpHour })
  ↳ GoogleOAuthService.generateAuthUrl(userId) → shown as link

New pieces:
  ↳ user_profiles table (schema + migration)
  ↳ IUserProfileDB interface
  ↳ DrizzleUserProfileRepo
  ↳ GoogleOAuthService (shared helper — extracts URL generation from GoogleCalendarService)
  ↳ GET /api/oauth/google/callback HTTP endpoint (handles code exchange + token upsert)
```

No changes to use-case layer. All new code is adapters.

---

## Schema: New `user_profiles` Table

Telegram users are identified by a deterministic UUID derived from their chat ID (`uuidV5`). They have no row in the `users` table (which requires auth fields). A lightweight `user_profiles` table stores their setup data.

```ts
// schema.ts addition
export const userProfiles = pgTable("user_profiles", {
  userId: uuid("user_id").primaryKey(),
  displayName: text("display_name"),
  personalities: text("personalities").array().notNull().default([]),
  wakeUpHour: integer("wake_up_hour"),      // 0-23, UTC or local (store as-is)
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
```

**Why not reuse `users` table:** it requires `hashedPassword`, `email`, `dob`, and `status` — none of which exist for a Telegram-only user.

**Why not `user_memories`:** Structured data (personalities, wakeUpHour) shouldn't be stored as freeform text.

---

## IUserProfileDB Interface

```ts
// use-cases/interface/output/repository/userProfile.repo.ts

export interface IUserProfile {
  userId: string;
  displayName: string | null;
  personalities: string[];
  wakeUpHour: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface UserProfileUpsert {
  userId: string;
  displayName?: string;
  personalities: string[];
  wakeUpHour: number | null;
}

export interface IUserProfileDB {
  upsert(profile: UserProfileUpsert): Promise<void>;
  findByUserId(userId: string): Promise<IUserProfile | null>;
}
```

---

## DrizzleUserProfileRepo

```ts
// adapters/implementations/output/sqlDB/repositories/userProfile.repo.ts
// Standard Drizzle upsert pattern — same as DrizzleJarvisConfigRepo
```

---

## Setup Wizard: Step Design

The wizard has 3 phases: **Traits**, **Wake-up time**, **Authorization**.

### Phase 1 — Trait Questions

6 binary-choice questions. Each choice maps to `PERSONALITIES` enum values. Multiple personalities accumulate across all answers.

| # | Question | Choice A → traits | Choice B → traits |
|---|---|---|---|
| 1 | "When I explain things, do you prefer: **(a)** Short & to the point  **(b)** Detailed & comprehensive" | `MINIMALIST` | `THOROUGH` |
| 2 | "How should I talk to you? **(a)** Casual, like a friend  **(b)** Professional & formal" | `CASUAL` | `FORMAL` |
| 3 | "Do you want humor in our conversations? **(a)** Yes, keep it fun  **(b)** No, stay focused" | `HUMOROUS` | _(none)_ |
| 4 | "When solving problems, you trust: **(a)** Logic & data  **(b)** Gut feeling & instinct" | `ANALYTICAL`, `LOGICAL` | `INTUITIVE` |
| 5 | "When giving feedback, should I be: **(a)** Blunt & direct  **(b)** Thoughtful & gentle" | `DIRECT` | `EMPATHETIC`, `SUPPORTIVE` |
| 6 | "My energy level should be: **(a)** High energy & enthusiastic  **(b)** Calm & steady" | `ENTHUSIASTIC` | `CALM`, `PATIENT` |

After Q6: collected personalities array is ready.

### Phase 1.1 — Wake-up Hour

```
Q7: "What time do you usually wake up? Reply with just the hour (0–23, e.g. 7 for 7 AM)."
```

Validates: `parseInt(answer)` is in range 0–23. On invalid input, ask again (don't advance step).

### Phase 2 — Google Authorization

After storing the profile, generate and show the Google OAuth URL:

```
To connect Google Calendar and Gmail, tap this link and authorize access:

<auth_url>

Once authorized in your browser, come back here — you're all set!
```

The OAuth callback is handled by a new HTTP endpoint (see below).

---

## SetupSession State Machine

```ts
type SetupStep =
  | { phase: "traits"; questionIndex: number; collectedTraits: PERSONALITIES[] }
  | { phase: "wakeup" }
  | { phase: "done" };

interface SetupSession {
  step: SetupStep;
  collectedTraits: PERSONALITIES[];
}
```

Stored in `TelegramAssistantHandler`:
```ts
private setupSessions = new Map<number, SetupSession>();
```

In the `register(bot)` method:
- `/setup` command → creates/resets `SetupSession` for the chat, sends Q1
- `bot.on("message:text")` → if `setupSessions.has(ctx.chat.id)`, route to `handleSetupReply()` **before** calling `assistantUseCase.chat()`

`handleSetupReply()`:
- Reads current step, parses `a`/`b` (case-insensitive, trimmed)
- Invalid input → re-send the same question with "Please reply a or b."
- Advances step on valid input
- On completion → calls `userProfileRepo.upsert()` + sends Google auth link → deletes session

---

## Google OAuth Service (Shared Helper)

Extract the auth URL generation into a standalone helper so both the Telegram handler and future HTTP routes can use it:

```ts
// adapters/implementations/output/googleOAuth/googleOAuth.service.ts

export class GoogleOAuthService {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly tokenRepo: IGoogleOAuthTokenDB,
  ) {}

  generateAuthUrl(userId: string): string {
    const oauth2Client = new OAuth2Client(this.clientId, this.clientSecret, this.redirectUri);
    return oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
      state: userId,   // passed back in callback so we know which user to store tokens for
      prompt: "consent",
    });
  }

  async handleCallback(code: string, userId: string): Promise<void> {
    const oauth2Client = new OAuth2Client(this.clientId, this.clientSecret, this.redirectUri);
    const { tokens } = await oauth2Client.getToken(code);
    const now = newCurrentUTCEpoch();
    await this.tokenRepo.upsert({
      id: newUuid(),
      userId,
      accessToken: tokens.access_token ?? "",
      refreshToken: tokens.refresh_token ?? "",
      expiresAtEpoch: tokens.expiry_date ? Math.floor(tokens.expiry_date / 1000) : now + 3600,
      scope: tokens.scope ?? "",
      updatedAtEpoch: now,
    });
  }
}
```

---

## HTTP Callback Endpoint (OAuth)

The OAuth redirect URI must point to a running HTTP server. Add a minimal route:

```
GET /api/oauth/google/callback?code=<code>&state=<userId>
```

In `assistantController` or a new `oauthController`:
- Extract `code` and `state` (userId) from query params
- Call `googleOAuthService.handleCallback(code, userId)`
- Reply with a plain "Authorization complete. Return to Telegram." page

This endpoint needs to be exposed at whatever `GOOGLE_REDIRECT_URI` is set to in `.env`. The HTTP server and Telegram bot can run in the same process or separate — the user must ensure the HTTP server is reachable at the redirect URI when the user clicks the link.

### `/code` Fallback Command

For cases where the HTTP server isn't publicly accessible, the user can complete OAuth manually:

1. Google redirects to `GOOGLE_REDIRECT_URI?code=<code>&state=<userId>` — even if the server isn't running, the code appears in the browser's address bar.
2. The user copies the `code` value and sends `/code <value>` in Telegram.
3. The bot calls `googleOAuthService.handleCallback(code, userId)` directly and replies with confirmation.

```ts
bot.command("code", async (ctx) => {
  const code = ctx.match?.trim();
  if (!code) return ctx.reply("Usage: /code <authorization_code>");

  const userId = this.resolveUserId(ctx.chat.id);
  try {
    await this.googleOAuthService.handleCallback(code, userId);
    await ctx.reply("Google account connected. Calendar and Gmail are ready.");
  } catch {
    await ctx.reply("Authorization failed. The code may be expired — run /setup again to get a new link.");
  }
});
```

This command is available at all times (not only during a setup session), so a user can re-authorize without going through the full wizard again.

---

## Wire-Up: DI Changes

`AssistantInject` gains two new repos and the OAuth service:

```ts
// New in AssistantInject (assistant.di.ts):
const userProfileRepo = new DrizzleUserProfileRepo(sqlDB.db);
const googleOAuthService = new GoogleOAuthService(
  process.env.GOOGLE_CLIENT_ID ?? "",
  process.env.GOOGLE_CLIENT_SECRET ?? "",
  process.env.GOOGLE_REDIRECT_URI ?? "",
  sqlDB.googleOAuthTokens,
);
```

`TelegramAssistantHandler` receives these two:

```ts
constructor(
  private readonly assistantUseCase: IAssistantUseCase,
  private readonly userProfileRepo: IUserProfileDB,
  private readonly googleOAuthService: GoogleOAuthService,
  private readonly fixedUserId?: string,
)
```

`DrizzleSqlDB` gains `userProfiles: DrizzleUserProfileRepo`.

---

## File Tree (new/changed files)

```
src/
  adapters/
    implementations/
      input/
        telegram/
          handler.ts                              ← add /setup, /code commands + SetupSession logic
      output/
        googleOAuth/
          googleOAuth.service.ts                  ← NEW: URL generation + callback handler
        sqlDB/
          schema.ts                               ← add userProfiles table
          drizzleSqlDb.adapter.ts                 ← add userProfiles repo
          repositories/
            userProfile.repo.ts                   ← NEW: DrizzleUserProfileRepo
    inject/
      assistant.di.ts                             ← wire userProfileRepo + googleOAuthService
  use-cases/
    interface/
      output/
        repository/
          userProfile.repo.ts                     ← NEW: IUserProfileDB interface

drizzle/migrations/
  <timestamp>_add_user_profiles.sql               ← NEW: migration
```

---

## Implementation Order

1. Add `user_profiles` to `schema.ts`
2. Create and run migration (`npm run db:generate && npm run db:migrate`)
3. Add `IUserProfileDB` interface + `UserProfileUpsert` type
4. Implement `DrizzleUserProfileRepo` (upsert via `onConflictDoUpdate`, same pattern as `DrizzleJarvisConfigRepo`)
5. Wire `userProfiles` into `DrizzleSqlDB`
6. Implement `GoogleOAuthService` (URL generation + callback)
7. Add `GET /api/oauth/google/callback` HTTP route
8. Update `TelegramAssistantHandler.register()`:
   - Add `setupSessions` map
   - Add `/setup` command handler
   - Add `/code <code>` fallback command
   - Intercept text messages for active setup sessions
   - Implement `handleSetupReply()` state machine
9. Update `AssistantInject` to construct and pass `userProfileRepo` + `googleOAuthService`
10. Update `telegramCli.ts` entry point to pass new deps to handler

---

## Open Questions / Decisions

1. **Wake-up hour timezone:** Store as the raw hour the user types (local-time intent). No timezone conversion. The reminder system can ask for timezone later or use it as-is.
2. **Re-running /setup:** Fully allowed — overwrites existing profile. Good for iteration.
3. **HTTP server requirement for OAuth:** The user must have the HTTP server running and `GOOGLE_REDIRECT_URI` publicly accessible for the automatic callback to work. If it isn't, the user can copy the `code` from the browser address bar and send `/code <value>` in Telegram as a fallback.
4. **No `/setup` required to use JARVIS:** The bot works without it. `/setup` is purely additive. Missing `wakeUpHour` or empty personalities just means no personalization yet.
5. **Personalities stored in `user_profiles`, not `users`:** Telegram users don't have a `users` row. The system prompt builder will need to load from `user_profiles` instead of (or in addition to) `users.personalities`. This is a follow-up concern for the system prompt assembly logic.
