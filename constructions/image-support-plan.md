# Image Support Plan

## Goal

When the user sends a photo via Telegram (with or without a caption), JARVIS reads and reasons about the image using `gpt-4o`'s vision capability and replies in the same conversational flow. No new tools are needed — vision is handled at the orchestrator level.

---

## Design Decisions

- **No DB schema change.** Telegram file URLs expire; storing raw image bytes in Postgres is wasteful. The image is converted to a base64 data URL in memory, injected into the current conversation history for the LLM call only, and the `content` column stores the caption text (or `[image]` if there is no caption). Past image messages will appear as `[image]` in history — this is an acceptable limitation for a first implementation.
- **No new tool.** Vision is part of the base LLM call, not a tool invocation.
- **Single code path.** After downloading and encoding, a photo message becomes a normal `chat()` call with an extra `imageBase64Url` field. The use case and orchestrator handle the rest.

---

## Flow

```
User sends photo (+ optional caption) via Telegram
      │
      ▼
TelegramAssistantHandler.on("message:photo")
  1. Pick highest-resolution PhotoSize
  2. ctx.api.getFile(fileId) → file_path
  3. Fetch https://api.telegram.org/file/bot{TOKEN}/{file_path}
  4. Convert response buffer → base64 data URL (image/jpeg)
  5. caption = ctx.message.caption ?? "[image]"
      │
      ▼
assistantUseCase.chat({
  userId, conversationId,
  message: caption,
  imageBase64Url: "data:image/jpeg;base64,..."
})
      │
      ▼
AssistantUseCaseImpl.chat()
  1. initConversation() — persists user message with content = caption text
  2. loadHistory() → IOrchestratorMessage[]
  3. Inject imageBase64Url into the last history entry (the user message just persisted)
      │
      ▼
OpenAIOrchestrator.chat()
  User message with imageBase64Url → content array:
  [
    { type: "text",      text: caption },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }
  ]
      │
      ▼
gpt-4o vision response → normal reply path
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/use-cases/interface/input/assistant.interface.ts` | Add `imageBase64Url?: string` to `IChatInput` |
| `src/use-cases/interface/output/orchestrator.interface.ts` | Add `imageBase64Url?: string` to `IOrchestratorMessage` |
| `src/use-cases/implementations/assistant.usecase.ts` | Inject `imageBase64Url` into last history entry after `loadHistory()` |
| `src/adapters/implementations/output/orchestrator/openai.ts` | Handle `imageBase64Url` when mapping user messages |
| `src/adapters/implementations/input/telegram/handler.ts` | Add `bot.on("message:photo", ...)` handler; accept `botToken` in constructor |

No new files. No DB migrations.

---

## Step-by-Step Implementation

### Step A — `IChatInput`: add optional image field

**File:** `src/use-cases/interface/input/assistant.interface.ts`

Add one optional field to `IChatInput`:

```typescript
export interface IChatInput {
  userId: string;
  conversationId?: string;
  message: string;
  /** Base64 data URL of an attached image, e.g. "data:image/jpeg;base64,..." */
  imageBase64Url?: string;
}
```

No other changes in this file.

---

### Step B — `IOrchestratorMessage`: add optional image field

**File:** `src/use-cases/interface/output/orchestrator.interface.ts`

Add one optional field to `IOrchestratorMessage`:

```typescript
export interface IOrchestratorMessage {
  role: MESSAGE_ROLE;
  content: string;
  toolName?: string;
  toolCallId?: string;
  toolCallsJson?: string;
  /** Base64 data URL — present only on USER messages that include an image */
  imageBase64Url?: string;
}
```

No other changes in this file.

---

### Step C — `AssistantUseCaseImpl`: inject image into history

**File:** `src/use-cases/implementations/assistant.usecase.ts`

In `chat()`, after the `loadHistory()` call and before the orchestrator loop, add the image injection block. The user message was already persisted by `initConversation()` and is the last entry in the loaded history.

```typescript
async chat(input: IChatInput): Promise<IChatResponse> {
  const conversationId = await this.initConversation(input);
  const conversationHistory = await this.loadHistory(conversationId);

  // Inject image into the last (current) user message for this request only.
  // The DB stores text content; the image data is ephemeral.
  if (input.imageBase64Url) {
    const last = conversationHistory[conversationHistory.length - 1];
    if (last?.role === MESSAGE_ROLE.USER) {
      last.imageBase64Url = input.imageBase64Url;
    }
  }

  const { systemPrompt, maxRounds } = await this.loadChatConfig(input.userId);
  // ... rest of the method unchanged
```

No other changes in this file.

---

### Step D — `OpenAIOrchestrator`: build vision content array

**File:** `src/adapters/implementations/output/orchestrator/openai.ts`

In the `.map()` that converts `IOrchestratorMessage` to `ChatCompletionMessageParam`, add a branch for user messages with an image. It must come before the default `return` at the bottom:

```typescript
// Inside input.conversationHistory.map(...)

// Vision: user message with attached image
if (msg.role === MESSAGE_ROLE.USER && msg.imageBase64Url) {
  return {
    role: "user",
    content: [
      { type: "text" as const,      text: msg.content || "What's in this image?" },
      { type: "image_url" as const, image_url: { url: msg.imageBase64Url } },
    ],
  };
}

// ... existing branches (ASSISTANT_TOOL_CALL, TOOL, default) follow unchanged
```

No other changes in this file.

---

### Step E — Telegram handler: photo event + download

**File:** `src/adapters/implementations/input/telegram/handler.ts`

**5a. Accept bot token in constructor.**

The token is needed to build the Telegram file download URL. Add it as a constructor parameter:

```typescript
constructor(
  private readonly assistantUseCase: IAssistantUseCase,
  private readonly userProfileRepo: IUserProfileDB,
  private readonly googleOAuthService: GoogleOAuthService,
  private readonly fixedUserId?: string,
  private readonly botToken?: string,    // add this
) {}
```

**5b. Add the photo handler inside `register()`.**

Place it directly after the `bot.on("message:text", ...)` block:

```typescript
bot.on("message:photo", async (ctx) => {
  if (this.setupSessions.has(ctx.chat.id)) return;

  const userId = this.resolveUserId(ctx.chat.id);
  const conversationId = this.conversations.get(ctx.chat.id);

  await ctx.replyWithChatAction("typing");

  try {
    const imageBase64Url = await this.downloadPhotoAsBase64(ctx);
    const caption = ctx.message.caption?.trim() || "[image]";

    const response = await this.assistantUseCase.chat({
      userId,
      conversationId,
      message: caption,
      imageBase64Url,
    });

    this.conversations.set(ctx.chat.id, response.conversationId);

    let reply = response.reply;
    if (response.toolsUsed.length > 0) {
      reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
    }

    await this.safeSend(ctx, reply);
  } catch (err) {
    console.error("Error handling photo:", err);
    await ctx.reply("Sorry, I couldn't process that image. Please try again.");
  }
});
```

**5c. Add the download helper method to `TelegramAssistantHandler`:**

```typescript
private async downloadPhotoAsBase64(ctx: Context): Promise<string> {
  // photos array is sorted smallest → largest; last entry is highest resolution
  const photos = (ctx.message as { photo?: { file_id: string }[] }).photo!;
  const fileId = photos[photos.length - 1].file_id;

  const file = await ctx.api.getFile(fileId);
  const token = this.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return `data:image/jpeg;base64,${base64}`;
}
```

**5d. Update the call site in `telegramCli.ts`** to pass the token:

```typescript
const handler = new TelegramAssistantHandler(
  useCase,
  sqlDB.userProfiles,
  googleOAuthService,
  fixedUserId,
  token,   // add this — token is already available at this scope
);
```

---

## What is explicitly NOT in scope

- Storing images persistently (S3, object storage, etc.)
- Multi-image messages (only the highest-res single photo is used)
- Voice + image combined messages
- Image generation tools
- Re-sending images that appeared in prior conversation turns (history shows `[image]` only)
