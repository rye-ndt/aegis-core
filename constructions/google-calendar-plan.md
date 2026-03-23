# Google Calendar Integration Plan

## Goal

Replace the `CalendarTool` stub with a fully working Google Calendar integration.
JARVIS should be able to **read**, **create**, **update**, and **delete** events on the user's
Google Calendar via natural language. The user provides Google credentials once via OAuth;
tokens are stored in the database and auto-refreshed silently afterwards.

---

## Architecture Overview

```
HTTP Layer                Use Case Layer           Output Adapters
─────────────────         ─────────────────        ──────────────────────────────
GoogleCalendarAuth        (no new use case)         GoogleCalendarService
  Controller                                          ↳ ICalendarService port
  GET /api/auth/google                                ↳ uses googleapis + stored tokens
  GET /api/auth/google/cb                             ↳ loads/saves via IGoogleOAuthTokenDB

                          AssistantUseCaseImpl      DrizzleGoogleOAuthTokenRepo
                            (unchanged)               ↳ new table: google_oauth_tokens
                            registryFactory            ↳ DrizzleSqlDb facade gets new repo

                          CalendarReadTool           (tools now hold ICalendarService)
                          CalendarWriteTool
                            (split from old CalendarTool)
```

---

## Step 1 — OAuth Token Storage (DB)

### New table: `google_oauth_tokens`

| Column           | Type    | Notes                                   |
|------------------|---------|-----------------------------------------|
| `id`             | UUID PK |                                         |
| `userId`         | UUID FK | references `users.id`                   |
| `accessToken`    | text    | short-lived (~1h); store to avoid extra refresh call |
| `refreshToken`   | text    | long-lived; the critical piece          |
| `expiresAtEpoch` | integer | UTC epoch seconds when accessToken expires |
| `scope`          | text    | granted scope string                    |
| `updatedAtEpoch` | integer |                                         |

Add to `schema.ts` alongside existing tables.

### New port: `IGoogleOAuthTokenDB`

```typescript
interface IGoogleOAuthTokenDB {
  findByUserId(userId: string): Promise<GoogleOAuthToken | null>;
  upsert(token: GoogleOAuthToken): Promise<void>;
}
```

Add `DrizzleGoogleOAuthTokenRepo` implementing this. Expose it via `DrizzleSqlDb` facade as
`sqlDB.googleOAuthTokens`.

---

## Step 2 — ICalendarService Port

New output interface at `src/use-cases/interface/output/calendarService.interface.ts`:

```typescript
interface ICalendarEvent {
  id?: string;
  summary: string;
  description?: string;
  location?: string;
  startDateTime: string;   // RFC3339, e.g. "2026-03-25T09:00:00"
  endDateTime: string;
  timeZone?: string;       // e.g. "America/New_York"
  attendees?: string[];    // email addresses
  reminderMinutes?: number;
}

interface ICalendarService {
  listEvents(userId: string, params: {
    startDateTime: string;
    endDateTime: string;
    query?: string;
    maxResults?: number;
    calendarId?: string;
  }): Promise<ICalendarEvent[]>;

  createEvent(userId: string, event: ICalendarEvent): Promise<{ id: string; htmlLink: string }>;

  updateEvent(userId: string, eventId: string, patch: Partial<ICalendarEvent>): Promise<void>;

  deleteEvent(userId: string, eventId: string): Promise<void>;
}
```

---

## Step 3 — GoogleCalendarService Adapter

New file: `src/adapters/implementations/output/calendarService/google.calendarService.ts`

### Responsibilities
- Loads stored OAuth tokens for the user from `IGoogleOAuthTokenDB`
- Builds a `google.auth.OAuth2` client and calls `setCredentials()`
- Listens to `'tokens'` event → persists updated tokens back to DB (handles silent refresh)
- Calls the `googleapis` calendar methods for each operation
- Throws a typed error (e.g. `CalendarNotConnectedError`) when no tokens exist for the user

### Constructor deps
```typescript
constructor(
  private readonly tokenRepo: IGoogleOAuthTokenDB,
  private readonly clientId: string,      // from env: GOOGLE_CLIENT_ID
  private readonly clientSecret: string,  // from env: GOOGLE_CLIENT_SECRET
  private readonly redirectUri: string,   // from env: GOOGLE_REDIRECT_URI
)
```

### Token lifecycle
1. `findByUserId(userId)` → if null → throw `CalendarNotConnectedError`
2. `oauth2Client.setCredentials({ access_token, refresh_token, expiry_date })`
3. Register `oauth2Client.on('tokens', handler)` before every call to catch auto-refresh
4. Handler calls `tokenRepo.upsert(...)` with updated tokens

---

## Step 4 — OAuth Endpoints

New controller: `src/adapters/implementations/input/http/googleCalendarAuth.controller.ts`

### Routes

```
GET /api/auth/google/calendar
  → generate Google OAuth URL (access_type: 'offline', prompt: 'consent')
  → redirect user to Google consent screen

GET /api/auth/google/calendar/callback?code=...&state=<userId>
  → exchange code for tokens via oauth2Client.getToken(code)
  → upsert into google_oauth_tokens
  → respond 200 "Calendar connected successfully"
```

### State parameter
- Encode `userId` in the `state` param of the OAuth URL (signed or JWT-wrapped to prevent CSRF)
- On callback, decode `state` to get `userId` for token association

### Auth for the initial redirect
- The redirect endpoint requires a valid Bearer token (same JWT middleware as other endpoints)
- Extract `userId` from the verified JWT, embed in `state`

### Env vars needed
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/calendar/callback
```

---

## Step 5 — Calendar Tools (Replace Stub)

Split the old single `CalendarTool` (CALENDAR_READ only) into two tools.

### `CalendarReadTool` (replaces old `CalendarTool`)
- Uses `TOOL_TYPE.CALENDAR_READ`
- Calls `ICalendarService.listEvents()`
- Input schema: `startDateTime`, `endDateTime`, `query?`, `maxResults?`, `calendarId?`
- Error case: if `CalendarNotConnectedError` → return a user-friendly message pointing to the OAuth flow

### `CalendarWriteTool`
- Uses `TOOL_TYPE.CALENDAR_WRITE` (already in enum)
- Single tool with an `action` discriminator: `"create" | "update" | "delete"`
- Why one tool instead of three: reduces tool-list length; LLM can handle a discriminated schema well
- Input schema:
  ```json
  {
    "action": "create" | "update" | "delete",
    "eventId": "string (required for update/delete)",
    "event": { /* ICalendarEvent shape, required for create, optional for update */ }
  }
  ```
- Dispatches to `createEvent`, `updateEvent`, or `deleteEvent` on `ICalendarService`

### Constructor for both tools
```typescript
constructor(
  private readonly userId: string,
  private readonly calendarService: ICalendarService,
)
```

---

## Step 6 — Wire into DI (AssistantInject)

In `assistant.di.ts`, inside `registryFactory`:

1. Instantiate `GoogleCalendarService` once as a singleton (like `embeddingService`)
2. Pass it + `userId` into `CalendarReadTool` and `CalendarWriteTool`
3. Replace old `new CalendarTool()` with the two new tools

`GoogleCalendarService` needs `tokenRepo = sqlDB.googleOAuthTokens` and the three env vars.

Also register `GoogleCalendarAuthController` in `src/adapters/inject/index.ts` and add its
routes to the HTTP server.

---

## Step 7 — Error Handling

Define `CalendarNotConnectedError` (extends `Error`). Both calendar tools catch it and return:
```json
{
  "success": false,
  "error": "Google Calendar is not connected. Ask the user to visit /api/auth/google/calendar to authorize access."
}
```
The LLM will then relay this message to the user naturally.

---

## File Changelist

| Action | File |
|--------|------|
| Add    | `src/adapters/implementations/output/sqlDB/schema.ts` — `google_oauth_tokens` table |
| Add    | `src/use-cases/interface/output/repository/googleOAuthToken.repo.ts` |
| Add    | `src/adapters/implementations/output/sqlDB/repositories/googleOAuthToken.repo.ts` |
| Modify | `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` — expose `googleOAuthTokens` |
| Add    | `src/use-cases/interface/output/calendarService.interface.ts` |
| Add    | `src/adapters/implementations/output/calendarService/google.calendarService.ts` |
| Modify | `src/adapters/implementations/output/tools/calendar.tool.ts` → `calendarRead.tool.ts` |
| Add    | `src/adapters/implementations/output/tools/calendarWrite.tool.ts` |
| Add    | `src/adapters/implementations/input/http/googleCalendarAuth.controller.ts` |
| Modify | `src/adapters/inject/assistant.di.ts` — wire new tools + calendar service |
| Modify | `src/adapters/inject/index.ts` — register auth controller |
| Modify | `src/adapters/implementations/input/http/httpServer.ts` — add OAuth routes |
| Add    | drizzle migration (auto-generated) |

---

## Env Vars Summary

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/calendar/callback
```

---

## Open Questions / Decisions

1. **CSRF protection on OAuth state**: simplest is a short-lived HMAC-signed token containing
   `userId` + `timestamp`. Alternatively just store `userId` in a Redis key under a random nonce.

2. **CalendarId**: default to `'primary'`. Optionally let user specify which calendar.
   Could store preferred calendarId per user in `google_oauth_tokens` or a separate config.

3. **Timezone**: default to UTC. Better: store user's preferred timezone in user profile or
   derive from calendar settings (`calendarList.list()` returns timezone per calendar).

4. **consoleCli.ts (non-HTTP path)**: OAuth can't redirect in a CLI context. For CLI testing,
   provide a separate one-time script (e.g. `npm run google-auth`) that prints the OAuth URL,
   waits for the user to paste the code, and stores the token — analogous to `jarvisCli.ts`.
