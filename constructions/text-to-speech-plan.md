# Text-to-Speech Response Plan

## Goal

Allow users to prefix any message with `/speech` to receive the assistant's reply as a Telegram voice message instead of text. The use case layer is untouched — TTS is a presentation-layer concern handled entirely in the Telegram adapter.

---

## VibeVoice feasibility note

`microsoft/VibeVoice` is Python-only (PyTorch + Hugging Face Transformers, 1.5B param model, no npm package). Using it from this TypeScript project requires a separate Python microservice (e.g. FastAPI), adding significant infra complexity.

**Recommendation: use OpenAI TTS instead.** The project already has an OpenAI key; `openai.audio.speech.create` is a single HTTP call, returns Opus audio (native Telegram voice format), and requires zero new infrastructure.

VibeVoice remains viable if you later want local/offline TTS — just swap the adapter (Step 2 below) with an HTTP client pointing at a VibeVoice FastAPI service. The interface is the same.

---

## Steps

### Step 1 — Add `ITextToSpeech` outbound port

**File:** `src/use-cases/interface/output/tts.interface.ts`

```typescript
export interface ITTSInput {
  text: string;
  voice?: string; // provider-specific voice name, optional
}

export interface ITTSOutput {
  audioBuffer: Buffer;
  mimeType: string; // e.g. "audio/ogg; codecs=opus"
}

export interface ITextToSpeech {
  synthesize(input: ITTSInput): Promise<ITTSOutput>;
}
```

Mirror the shape of `ISpeechToText` for consistency.

---

### Step 2 — Implement OpenAI TTS adapter

**File:** `src/adapters/implementations/output/textToSpeech/openai.ts`

- Constructor takes `apiKey: string` and creates its own `new OpenAI({ apiKey })` — same pattern as every other OpenAI adapter in this codebase (`embedding/openai.ts`, `textGenerator/openai.ts`). No shared client.
- Call `this.client.audio.speech.create({ model: "tts-1", voice: input.voice ?? "alloy", input: input.text, response_format: "opus" })`.
- Convert the response to a `Buffer` via `Buffer.from(await response.arrayBuffer())`.
- Return `{ audioBuffer, mimeType: "audio/ogg; codecs=opus" }`.

Opus/OGG is the format Telegram expects for voice messages — no re-encoding needed.

---

### Step 3 — Wire in DI container

**File:** `src/adapters/inject/assistant.di.ts`

- Add a private nullable field `private tts: ITextToSpeech | null = null`.
- Add a `getTTS(): ITextToSpeech` getter that lazy-inits `new OpenAITTS(process.env.OPENAI_API_KEY ?? "")` — same lazy-singleton pattern as `getGoogleOAuthService()`.
- Pass `apiKey` as a string, consistent with how every other OpenAI adapter is wired here.

---

### Step 4 — Update `TelegramAssistantHandler` to accept TTS service

**File:** `src/adapters/implementations/input/telegram/handler.ts`

- Add `private readonly tts: ITextToSpeech` to the constructor.
- Register a new `bot.command("speech", ...)` handler:
  1. Extract `ctx.match` (the text after `/speech`) as the user message.
  2. If empty, reply with usage hint and return.
  3. Call `assistantUseCase.chat({ userId, conversationId, message: ctx.match })` as usual.
  4. Pass `response.reply` directly to `this.tts.synthesize({ text: response.reply })` — do NOT append the `[tools: ...]` annotation; synthesising metadata into audio is nonsensical. If tools were used and you want to surface that, send it as a separate follow-up text message after the voice note.
  5. Send via `ctx.replyWithVoice(new InputFile(audioBuffer, "reply.ogg"))`.
  6. Update `this.conversations` with the returned `conversationId`.
- Existing `message:text` and `message:photo` handlers are unchanged — they always respond with text.

Error handling: if TTS synthesis fails, catch and fall back to sending the text reply with a note that voice was unavailable.

---

### Step 5 — Update entry point

**File:** `src/telegramCli.ts`

- Call `inject.getTTS()` and pass it into the `TelegramAssistantHandler` constructor.

---

## Data flow

```
User: /speech what's on my calendar today?
        │
        ▼
TelegramAssistantHandler.command("speech")
  ctx.match = "what's on my calendar today?"
        │
        ▼
AssistantUseCaseImpl.chat()   ← unchanged
  returns { reply: "You have...", ... }
        │
        ▼
OpenAITTS.synthesize({ text: response.reply })
  returns { audioBuffer: Buffer, mimeType: "audio/ogg; codecs=opus" }
        │
        ▼
ctx.replyWithVoice(new InputFile(audioBuffer, "reply.ogg"))
```

---

## What is NOT changed

- `AssistantUseCaseImpl` — no modifications.
- All existing outbound port interfaces — no modifications.
- `message:text` and `message:photo` handlers — unchanged, always text.
- DB schema — no new tables needed.

---

## Files touched / created

| Action | File |
|--------|------|
| Create | `src/use-cases/interface/output/tts.interface.ts` |
| Create | `src/adapters/implementations/output/textToSpeech/openai.ts` |
| Edit   | `src/adapters/inject/assistant.di.ts` |
| Edit   | `src/adapters/implementations/input/telegram/handler.ts` |
| Edit   | `src/telegramCli.ts` |

No migrations, no new env vars (reuses `OPENAI_API_KEY`).
