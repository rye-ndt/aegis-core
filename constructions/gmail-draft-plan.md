# Gmail Email Drafting Plan

## Goal

JARVIS can draft a reply email on behalf of the user via natural language. The user says something
like _"reply to Joan and say I'll attend the interview he mentioned"_. JARVIS searches Gmail for
the relevant thread, composes a contextually accurate draft, saves it to Gmail Drafts — and never
sends it without the user's explicit action.

---

## Agentic Flow Overview

```
User utterance
      │
      ▼
[CONVERSATIONAL CHECK]  ── Step 1 ──────────────────────────────────────────
  LLM inspects intent: does the user mention or imply a recipient email address?
  If NOT → LLM asks: "What is Joan's email address?" (plain text reply, no tool call)
  If YES → proceed to Step 1.2
      │
      ▼
[LLM → TOOL CALL]  ── Step 1.2 ─────────────────────────────────────────────
  Tool: gmail_search_emails
  LLM produces a Gmail query string from intent + known email address.
  Output: up to 10 email summaries (id, threadId, from, to, subject, snippet, date)
      │
      ▼ (tool result returned to LLM)
[LLM → TOOL CALL]  ── Steps 3 + 4 combined ─────────────────────────────────
  Tool: gmail_create_draft
  LLM reads the search results, picks the best matching thread, and composes:
    - to[]         : recipient address(es)
    - subject      : "Re: <original subject>"
    - body         : full reply text
    - threadId     : Gmail thread ID to attach the reply to the correct chain
    - replyToMessageId : Message-ID header of the email being replied to
      │
      ▼ (tool executes Gmail API)
[GMAIL API]  ── Step 5 ──────────────────────────────────────────────────────
  gmail.users.drafts.create() called with RFC 2822 MIME message + threadId
  Returns: { draftId }
      │
      ▼ (tool result returned to LLM)
[LLM TEXT REPLY]  ── Step 6 ──────────────────────────────────────────────────
  LLM confirms to user: draft saved, check Gmail Drafts folder. No send occurs.
```

---

## Tool Definitions (JSON Schema contracts)

### Tool 1 — `gmail_search_emails`

**Purpose:** Let the LLM query the user's Gmail inbox with a structured filter. Returns up to 10
summaries. This is a pure read tool — no side effects.

**When LLM calls this:**
After the user confirms an email address, the LLM translates the natural-language intent into a
Gmail query string (same syntax as the Gmail search bar, e.g. `from:joan subject:interview`).

**Input schema:**
```typescript
// src/adapters/implementations/output/tools/gmailSearchEmails.tool.ts
const InputSchema = z.object({
  query: z
    .string()
    .describe(
      'Gmail search query string (Gmail search syntax). Examples: "from:joan@example.com", ' +
      '"subject:interview", "from:joan subject:interview". Combine terms with spaces.'
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(10)
    .describe("Maximum number of emails to return. Hard-capped at 10."),
});
```

**Output (IToolOutput.data):**
```typescript
// Array serialised to string for LLM consumption
export interface IGmailEmailSummary {
  messageId: string;    // Gmail message ID — needed for In-Reply-To header
  threadId: string;     // Gmail thread ID — needed for threading the draft
  from: string;         // "Joan Smith <joan@example.com>"
  to: string[];         // recipient(s) from the original email
  subject: string;      // original subject line
  snippet: string;      // ~100-char Gmail snippet
  date: string;         // RFC 2822 date string, e.g. "Mon, 24 Mar 2026 09:12:00 +0000"
  messageIdHeader: string; // Value of the Message-ID header (for In-Reply-To / References)
}
```

---

### Tool 2 — `gmail_create_draft`

**Purpose:** Create a Gmail draft. This is the only side-effecting tool in the flow.
The LLM composes all fields from the search results + user intent.

**When LLM calls this:**
After receiving tool 1's results, the LLM identifies the best matching email thread and
constructs the full draft. It must not call this tool if no relevant email was found — it should
ask the user for clarification instead.

**Input schema:**
```typescript
// src/adapters/implementations/output/tools/gmailCreateDraft.tool.ts
const InputSchema = z.object({
  to: z
    .array(z.string().email())
    .min(1)
    .describe("Recipient email address(es)."),
  subject: z
    .string()
    .describe(
      'Email subject line. For replies, prefix with "Re: " and keep the original subject.'
    ),
  body: z
    .string()
    .describe("Full email body. Plain text. Write a complete, professional email."),
  threadId: z
    .string()
    .optional()
    .describe(
      "Gmail thread ID from the search results. Include this to attach the draft to an existing thread."
    ),
  replyToMessageId: z
    .string()
    .optional()
    .describe(
      "The messageId (NOT the Message-ID header) of the email being replied to. " +
      "Used to set In-Reply-To threading headers."
    ),
  replyToMessageIdHeader: z
    .string()
    .optional()
    .describe(
      "The Message-ID header value (the angle-bracket string like <abc@mail.gmail.com>) " +
      "of the email being replied to. Placed in the RFC 2822 In-Reply-To and References headers."
    ),
});
```

**Output (IToolOutput.data):**
```typescript
{ draftId: string }   // Gmail draft ID, e.g. "r9054113838524672"
```

---

## Files to Create / Modify

### New files

| File | Purpose |
|------|---------|
| `src/use-cases/interface/output/gmailService.interface.ts` | Port: `IGmailService` + domain types |
| `src/adapters/implementations/output/gmailService/google.gmailService.ts` | Adapter: calls Gmail API via `googleapis` |
| `src/adapters/implementations/output/tools/gmailSearchEmails.tool.ts` | Tool wrapper for search |
| `src/adapters/implementations/output/tools/gmailCreateDraft.tool.ts` | Tool wrapper for draft creation |
| `src/helpers/errors/gmailNotConnected.error.ts` | Typed error (same pattern as `CalendarNotConnectedError`) |

### Modified files

| File | Change |
|------|--------|
| `src/helpers/enums/toolType.enum.ts` | Add `GMAIL_SEARCH_EMAILS = "gmail_search_emails"` and `GMAIL_CREATE_DRAFT = "gmail_create_draft"` |
| `src/adapters/inject/assistant.di.ts` | Instantiate `GoogleGmailService`; register both tools in `registryFactory` |

> **Note on OAuth scope:** The existing `google_oauth_tokens` table is reused as-is. However,
> the OAuth initiation endpoint (not yet built — item 3 in STATUS.md todos) **must request Gmail
> scopes** alongside Calendar scopes. Add `https://www.googleapis.com/auth/gmail.modify` to the
> scope list. Users who already authorized Calendar-only will need to re-authorize.

---

## Step-by-Step Implementation

---

### Step A — `IGmailService` port interface

**File:** `src/use-cases/interface/output/gmailService.interface.ts`

```typescript
export interface IGmailEmailSummary {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  date: string;
  messageIdHeader: string;
}

export interface IGmailDraftInput {
  to: string[];
  subject: string;
  body: string;
  threadId?: string;
  replyToMessageId?: string;       // Gmail messageId (used to fetch In-Reply-To header)
  replyToMessageIdHeader?: string; // RFC 2822 Message-ID header value
}

export interface IGmailService {
  searchEmails(
    userId: string,
    params: { query: string; maxResults: number }
  ): Promise<IGmailEmailSummary[]>;

  createDraft(
    userId: string,
    draft: IGmailDraftInput
  ): Promise<{ draftId: string }>;
}
```

---

### Step B — `GmailNotConnectedError`

**File:** `src/helpers/errors/gmailNotConnected.error.ts`

Mirror `CalendarNotConnectedError` exactly:
```typescript
export class GmailNotConnectedError extends Error {
  constructor(userId: string) {
    super(`Gmail not connected for user ${userId}`);
    this.name = "GmailNotConnectedError";
  }
}
```

---

### Step C — `GoogleGmailService` adapter

**File:** `src/adapters/implementations/output/gmailService/google.gmailService.ts`

Constructor signature — identical pattern to `GoogleCalendarService`:
```typescript
constructor(
  private readonly tokenRepo: IGoogleOAuthTokenDB,
  private readonly clientId: string,
  private readonly clientSecret: string,
  private readonly redirectUri: string,
)
```

**`buildClient(userId)`** — copy verbatim from `GoogleCalendarService`. Same token refresh +
persist logic. Returns `OAuth2Client`.

**`searchEmails(userId, { query, maxResults })`** implementation:
1. `auth = await this.buildClient(userId)` — throws `GmailNotConnectedError` if no token
2. `gmail = google.gmail({ version: 'v1', auth })`
3. `listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults })`
   - If `listRes.data.messages` is empty → return `[]`
4. For each message ID (up to `maxResults`):
   - `msgRes = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID'] })`
   - Extract headers by name from `msgRes.data.payload.headers`
   - Collect `{ messageId: id, threadId, from, to[], subject, snippet, date, messageIdHeader }`
5. Return array of `IGmailEmailSummary`

**`createDraft(userId, draft)`** implementation:
1. `auth = await this.buildClient(userId)`
2. `gmail = google.gmail({ version: 'v1', auth })`
3. Build RFC 2822 raw message string:
   ```
   From: me\r\n
   To: recipient1@example.com, recipient2@example.com\r\n
   Subject: Re: Interview\r\n
   In-Reply-To: <messageIdHeader>\r\n        ← only if replyToMessageIdHeader provided
   References: <messageIdHeader>\r\n         ← only if replyToMessageIdHeader provided
   Content-Type: text/plain; charset=UTF-8\r\n
   \r\n
   <body text>
   ```
4. `encodedRaw = Buffer.from(rawMessage).toString('base64url')`
5. `res = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: encodedRaw, threadId: draft.threadId } } })`
6. Return `{ draftId: res.data.id }`

---

### Step D — `GmailSearchEmailsTool`

**File:** `src/adapters/implementations/output/tools/gmailSearchEmails.tool.ts`

```typescript
export class GmailSearchEmailsTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly gmailService: IGmailService,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.GMAIL_SEARCH_EMAILS,
      description:
        "Search the user's Gmail inbox using Gmail query syntax. " +
        "Returns up to 10 email summaries including sender, subject, snippet, threadId, and messageId. " +
        "Use this before drafting a reply to find the relevant email thread.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const { query, maxResults } = InputSchema.parse(input);
      const emails = await this.gmailService.searchEmails(this.userId, { query, maxResults });

      if (emails.length === 0) {
        return { success: true, data: "No emails found matching the query." };
      }

      // Format for LLM readability
      const formatted = emails.map((e, i) => [
        `${i + 1}. MessageID: ${e.messageId} | ThreadID: ${e.threadId}`,
        `   From: ${e.from}`,
        `   To: ${e.to.join(", ")}`,
        `   Subject: ${e.subject}`,
        `   Date: ${e.date}`,
        `   Snippet: ${e.snippet}`,
        `   Message-ID header: ${e.messageIdHeader}`,
      ].join("\n")).join("\n\n");

      return { success: true, data: formatted };
    } catch (err) {
      if (err instanceof GmailNotConnectedError) {
        return {
          success: false,
          error:
            "Gmail is not connected. Ask the user to visit /api/auth/google to authorize Gmail access.",
        };
      }
      throw err;
    }
  }
}
```

---

### Step E — `GmailCreateDraftTool`

**File:** `src/adapters/implementations/output/tools/gmailCreateDraft.tool.ts`

```typescript
export class GmailCreateDraftTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly gmailService: IGmailService,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.GMAIL_CREATE_DRAFT,
      description:
        "Create a Gmail draft on behalf of the user. " +
        "The draft is saved to Gmail Drafts and NOT sent automatically. " +
        "Use threadId and replyToMessageIdHeader from gmail_search_emails results when replying. " +
        "After calling this tool, tell the user to check their Gmail Drafts folder.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const parsed = InputSchema.parse(input);
      const { draftId } = await this.gmailService.createDraft(this.userId, parsed);
      return {
        success: true,
        data: `Draft created successfully. Draft ID: ${draftId}. The draft is in Gmail Drafts — it has NOT been sent.`,
      };
    } catch (err) {
      if (err instanceof GmailNotConnectedError) {
        return {
          success: false,
          error:
            "Gmail is not connected. Ask the user to visit /api/auth/google to authorize Gmail access.",
        };
      }
      throw err;
    }
  }
}
```

---

### Step F — Enum + DI wiring

**`toolType.enum.ts`** — add two values:
```typescript
GMAIL_SEARCH_EMAILS = "gmail_search_emails",
GMAIL_CREATE_DRAFT  = "gmail_create_draft",
```

**`assistant.di.ts`** — inside `getUseCase()`:
```typescript
// Singleton Gmail service — same token store as Calendar
const gmailService = new GoogleGmailService(
  sqlDB.googleOAuthTokens,
  process.env.GOOGLE_CLIENT_ID ?? "",
  process.env.GOOGLE_CLIENT_SECRET ?? "",
  process.env.GOOGLE_REDIRECT_URI ?? "",
);

// Inside registryFactory(userId):
r.register(new GmailSearchEmailsTool(userId, gmailService));
r.register(new GmailCreateDraftTool(userId, gmailService));
```

---

## OAuth Scope Note

The Google OAuth initiation endpoint (not yet built — see STATUS.md item 3) must request:

```
https://www.googleapis.com/auth/calendar          ← existing (Calendar)
https://www.googleapis.com/auth/gmail.modify      ← new (Gmail search + draft)
```

`gmail.modify` covers both reading messages (needed for search) and creating drafts. A single
OAuth flow covering both Calendar and Gmail is the simplest approach since `google_oauth_tokens`
is already per-user and the `scope` column records what was granted.

---

## System Prompt Guidance

Add to the JARVIS system prompt (via `jarvisCli.ts` / `npm run jarvis`):

```
When the user asks to reply to or draft an email:
1. Confirm the recipient's email address if not stated explicitly.
2. Use gmail_search_emails to find the relevant thread before composing.
3. Use gmail_create_draft to save the email. Always include threadId for replies.
4. NEVER call gmail_create_draft without first calling gmail_search_emails unless
   the user is composing a completely new email (not a reply).
5. After creating the draft, inform the user it is saved in Gmail Drafts and has NOT been sent.
```

---

## What is explicitly NOT in scope

- Sending emails (no `gmail_send_draft` tool — the draft is the final output)
- Listing all drafts
- Deleting or updating existing drafts
- Attachments
