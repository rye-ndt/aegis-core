# Hear — Voice Input Plan

## Goal

Accept Telegram voice messages, transcribe them via OpenAI Whisper, pass the text into the existing `chat()` flow, and always reply with a voice message. The inverse of `/speech`.

---

## What already exists

| Component | State |
|-----------|-------|
| `ISpeechToText` interface | Done — `src/use-cases/interface/output/stt.interface.ts` |
| `IVoiceChatInput` + `voiceChat()` on `IAssistantUseCase` | Done |
| `AssistantUseCaseImpl.voiceChat()` | Done — calls `speechToText.transcribe()` then delegates to `chat()` |
| `WhisperSpeechToText` | Stub — constructor exists, `transcribe()` throws |
| STT wired in `assistant.di.ts` | Done — `speechToText` passed to use case |
| `ITextToSpeech` (`tts`) injected in `TelegramAssistantHandler` | Done |
| `message:voice` handler | Missing |

Only two things are missing: the Whisper implementation and the Telegram voice handler.

---

## Steps

### Step 1 — Implement `WhisperSpeechToText.transcribe()`

**File:** `src/adapters/implementations/output/stt/whisper..ts`

- Instantiate `new OpenAI({ apiKey })` inside the constructor (same pattern as every other OpenAI adapter — `textToSpeech/openai.ts`, `embedding/openai.ts`, `textGenerator/openai.ts`).
- In `transcribe()`:
  1. Convert `input.audioBuffer` into a file object using `toFile(input.audioBuffer, "audio.ogg", { type: input.mimeType })` — the `toFile` helper is exported directly from the `openai` package, no extra dependency needed.
  2. Call `this.client.audio.transcriptions.create({ model: "whisper-1", file })`.
  3. Return `{ text: transcription.text }`.

Telegram sends voice messages as OGG/Opus. Whisper accepts OGG natively. No re-encoding.

---

### Step 2 — Register `message:voice` handler

**File:** `src/adapters/implementations/input/telegram/handler.ts`

Register the handler inside `register(bot)`, alongside `message:text` and `message:photo`:

```
bot.on("message:voice", async (ctx) => {
  // Guard: silently ignore voice messages during /setup quiz (matches message:photo pattern)
  if (this.setupSessions.has(ctx.chat.id)) return;

  const userId = this.resolveUserId(ctx.chat.id);
  const conversationId = this.conversations.get(ctx.chat.id);

  await ctx.replyWithChatAction("record_voice");

  try {
    // 1. Download voice file from Telegram
    const audioBuffer = await this.downloadVoiceAsBuffer(ctx);

    // 2. Transcribe + chat — voiceChat() handles both internally
    const response = await this.assistantUseCase.voiceChat({
      userId,
      conversationId,
      audioBuffer,
      mimeType: "audio/ogg",
    });

    this.conversations.set(ctx.chat.id, response.conversationId);

    // 3. Always reply with voice (MUST requirement)
    try {
      const { audioBuffer: replyAudio } = await this.tts.synthesize({
        text: response.reply,
      });
      await ctx.replyWithVoice(new InputFile(replyAudio, "reply.ogg"));
      if (response.toolsUsed.length > 0) {
        await ctx.reply(`[tools: ${response.toolsUsed.join(", ")}]`);
      }
    } catch (ttsErr) {
      // hard TTS failure only — reply with text as last resort
      console.error("TTS failed for voice reply:", ttsErr);
      let reply = response.reply;
      if (response.toolsUsed.length > 0) {
        reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
      }
      await this.safeSend(ctx, reply + "\n\n_(voice reply unavailable)_");
    }
  } catch (err) {
    console.error("Error handling voice message:", err);
    await ctx.reply(
      "Sorry, I couldn't process that voice message. Please try again.",
    );
  }
});
```

Add a private helper `downloadVoiceAsBuffer(ctx)` — mirrors the existing `downloadPhotoAsBase64(ctx)` exactly, just targets `ctx.message.voice.file_id` and returns a raw `Buffer` (no base64 conversion):

```
private async downloadVoiceAsBuffer(ctx: Context): Promise<Buffer> {
  const voice = (ctx.message as { voice?: { file_id: string } }).voice!;
  const file = await ctx.api.getFile(voice.file_id);
  const token = this.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
}
```

---

## Data flow

```
User sends voice message (OGG/Opus)
        │
        ▼
TelegramAssistantHandler.on("message:voice")
  downloadVoiceAsBuffer() → Buffer
        │
        ▼
AssistantUseCaseImpl.voiceChat()
  WhisperSpeechToText.transcribe({ audioBuffer, mimeType: "audio/ogg" })
    → openai.audio.transcriptions.create({ model: "whisper-1", file })
    → { text: "transcribed words..." }
        │
        ▼
  AssistantUseCaseImpl.chat({ userId, conversationId, message: transcription.text })
    → tool loop → persist → IChatResponse { reply, ... }
        │
        ▼
OpenAITTS.synthesize({ text: response.reply })
  → { audioBuffer: Buffer, mimeType: "audio/ogg; codecs=opus" }
        │
        ▼
ctx.replyWithVoice(new InputFile(replyAudio, "reply.ogg"))
```

---

## What is NOT changed

- `assistant.di.ts` — STT is already wired; no new constructor args needed.
- `assistant.usecase.ts` — `voiceChat()` is already fully correct.
- `stt.interface.ts` — interface is already correct.
- `assistant.interface.ts` — `IVoiceChatInput` and `voiceChat()` already defined.
- DB schema — no new tables. Voice is transcribed to text and stored as a regular user message.
- No new env vars. Reuses `OPENAI_API_KEY` and `TELEGRAM_BOT_TOKEN`.

---

## Files touched

| Action | File |
|--------|------|
| Edit | `src/adapters/implementations/output/stt/whisper..ts` |
| Edit | `src/adapters/implementations/input/telegram/handler.ts` |

Two files. Zero new dependencies. Zero migrations.

---

## Convention checklist

| Standard | Met? | Note |
|----------|------|------|
| Adapter implements existing interface | ✅ | `WhisperSpeechToText implements ISpeechToText` |
| OpenAI client owned per-adapter (no shared client) | ✅ | Same pattern as `OpenAITTS`, `OpenAIEmbeddingService` |
| Handler uses only injected dependencies | ✅ | `tts` and `assistantUseCase` already in constructor |
| Telegram file download mirrors existing pattern | ✅ | `downloadVoiceAsBuffer` mirrors `downloadPhotoAsBase64` |
| `setupSessions` guard on voice handler | ✅ | Matches `message:photo` pattern — silently ignores voice during `/setup` |
| Outer try/catch on voice handler | ✅ | Matches `/speech` and `message:photo` pattern — user gets feedback on any failure |
| No new env vars | ✅ | Reuses `OPENAI_API_KEY` |
| No DB changes | ✅ | Voice stored as transcribed text message (existing schema) |
| `toFile` from `openai` package (already a dep) | ✅ | No new packages |
