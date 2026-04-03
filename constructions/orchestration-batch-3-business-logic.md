# Orchestration Upgrade — Batch 3: Business Logic

## What this batch does

Rewrites `AssistantUseCaseImpl` to implement the full 10-phase pipeline, then wires the new
constructor args in the DI container.

**After this batch:** run `tsc --noEmit`, then run the full verification suite at the bottom.

## Prerequisites

Batches 1 and 2 must be complete and compiling. Specifically:
- `IConversationDB` has `upsertSummary`, `updateIntent`, `flagForCompression`
- `IMessageDB` has `findUncompressedByConversationId`, `markCompressed`
- `IEvaluationLogDB` and `EvaluationLog` exist
- `IOrchestratorResponse` has `usage?`
- `DrizzleSqlDB` has `evaluationLogs` property

---

## Step 7 — Rewrite `AssistantUseCaseImpl`

**File:** `src/use-cases/implementations/assistant.usecase.ts`

This is a full replacement of the file. The existing `voiceChat()`, `listConversations()`, and
`getConversation()` methods are kept unchanged. Everything else is rewritten.

### 7a — Imports

Replace all existing imports with:

```typescript
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import { CONVERSATION_STATUSES } from "../../helpers/enums/statuses.enum";
import { MESSAGE_ROLE } from "../../helpers/enums/messageRole.enum";
import { TOOL_TYPE } from "../../helpers/enums/toolType.enum";
import type {
  IAssistantUseCase,
  IChatInput,
  IChatResponse,
  IGetConversationInput,
  IListConversationsInput,
  IVoiceChatInput,
} from "../interface/input/assistant.interface";
import type { ISpeechToText } from "../interface/output/stt.interface";
import type {
  ILLMOrchestrator,
  IOrchestratorMessage,
  IToolCall,
} from "../interface/output/orchestrator.interface";
import type { IToolRegistry } from "../interface/output/tool.interface";
import type {
  Conversation,
  IConversationDB,
} from "../interface/output/repository/conversation.repo";
import type {
  IMessageDB,
  Message,
} from "../interface/output/repository/message.repo";
import type { IJarvisConfigDB } from "../interface/output/repository/jarvisConfig.repo";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";
import type { IEmbeddingService } from "../interface/output/embedding.interface";
import type { IVectorStore, IVectorQueryResult } from "../interface/output/vectorDB.interface";
import type { ITextGenerator } from "../interface/output/textGenerator.interface";
import type { IEvaluationLogDB } from "../interface/output/repository/evaluationLog.repo";
import type { IUserMemoryDB } from "../interface/output/repository/userMemory.repo";
```

### 7b — Constants and internal types

Add after the imports, before the class:

```typescript
const DEFAULT_SYSTEM_PROMPT =
  "You are JARVIS, a personal AI assistant. Be concise and helpful.";
const DEFAULT_MAX_TOOL_ROUNDS = 10;

interface IToolResult {
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  result: { success: boolean; data?: unknown; error?: unknown };
  latencyMs: number;
}
```

### 7c — Module-level helper functions

Add after the constants, before the class:

```typescript
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

function buildReasoningTrace(toolsUsed: IToolResult[]): string | null {
  if (toolsUsed.length === 0) return null;
  return toolsUsed
    .map((t, i) => `step ${i + 1}: ${t.toolName} → ${t.result.success ? "ok" : "error"}`)
    .join("\n");
}

// NOTE: Extracting reasoning from the final reply text is not viable with gpt-4o —
// the final response is just the answer. The tool call sequence above is the only
// reliable trace available.

function detectImplicitSignal(
  currentMessage: string,
  _previousResponse: string,
): string | null {
  const msg = currentMessage.toLowerCase();

  const correctionKeywords = [
    "actually,", "that's wrong", "that is wrong", "no,", "incorrect",
    "you said", "wait,", "not quite", "wrong,",
  ];
  const repeatKeywords = [
    "as i asked", "again,", "still need", "i already asked",
    "why didn't you", "you didn't",
  ];
  const clarificationKeywords = [
    "what do you mean", "can you explain", "i meant", "i was asking about", "clarify",
  ];

  if (correctionKeywords.some((k) => msg.includes(k))) return "correction";
  if (repeatKeywords.some((k) => msg.includes(k))) return "repeat";
  if (clarificationKeywords.some((k) => msg.includes(k))) return "clarification";
  return null;
}

function formatMessagesForPrompt(messages: Pick<Message, "role" | "content">[]): string {
  return messages.map((m) => `[${m.role}]: ${m.content}`).join("\n");
}
```

### 7d — Constructor

Replace the existing constructor with the new 12-dependency signature. `IUserDB` is removed;
`IUserProfileDB` takes its place for personality traits. Five new dependencies are added.

```typescript
export class AssistantUseCaseImpl implements IAssistantUseCase {
  constructor(
    private readonly speechToText: ISpeechToText,
    private readonly orchestrator: ILLMOrchestrator,
    private readonly registryFactory: (userId: string) => IToolRegistry,
    private readonly conversationRepo: IConversationDB,
    private readonly messageRepo: IMessageDB,
    private readonly jarvisConfigRepo: IJarvisConfigDB,
    private readonly userProfileRepo: IUserProfileDB,
    private readonly embeddingService: IEmbeddingService,
    private readonly vectorStore: IVectorStore,
    private readonly textGenerator: ITextGenerator,
    private readonly evaluationLogRepo: IEvaluationLogDB,
    private readonly userMemoryRepo: IUserMemoryDB,
  ) {}
```

### 7e — `voiceChat()`, `listConversations()`, `getConversation()` — unchanged

Keep these three methods exactly as they are. Only `chat()` and the private helpers change.

### 7f — `chat()` — full implementation

```typescript
async chat(input: IChatInput): Promise<IChatResponse> {

  // ─── INIT CONVERSATION ────────────────────────────────────────────────────
  // Creates conversation if new. Does NOT persist user message here —
  // user message is persisted in the parallel batch so allMessages loads
  // prior history only (concurrent INSERT not visible to concurrent SELECT
  // at READ COMMITTED isolation — intentional).
  const conversationId = await this.initConversation(input);

  // ─── PRE-CALL PARALLEL BATCH ──────────────────────────────────────────────
  const [allMessages, relevantMemories, config, userProfile, conversation] =
    await Promise.all([
      this.messageRepo.findByConversationId(conversationId),
      this.searchRelevantMemories(input.message, input.userId),
      this.jarvisConfigRepo.get(),
      this.userProfileRepo.findByUserId(input.userId),
      this.conversationRepo.findById(conversationId),
      this.messageRepo.create({
        id: newUuid(),
        conversationId,
        role: MESSAGE_ROLE.USER,
        content: input.message,
        createdAtEpoch: newCurrentUTCEpoch(),
      }),
    ] as const);

  const maxRounds =
    config?.maxToolRounds ??
    parseInt(process.env.MAX_TOOL_ROUNDS ?? String(DEFAULT_MAX_TOOL_ROUNDS));

  // ─── PHASE 1: COMPRESSION CHECK ───────────────────────────────────────────
  // Count only uncompressed messages — compressed messages are already in the
  // summary. Counting them would re-trigger compression every turn after the first.
  const uncompressed = allMessages.filter((m) => !m.compressedAtEpoch);
  const totalTokens = uncompressed.reduce(
    (sum, m) => sum + Math.ceil(m.content.length / 4),
    0,
  );

  let recentMessages: Message[];
  let currentSummary = conversation?.summary ?? null;

  if (totalTokens > 80_000 || conversation?.flaggedForCompression) {
    const tail = uncompressed.slice(-20);
    const toCompress = uncompressed.slice(0, -20);

    if (toCompress.length > 0) {
      const newSummary = await this.textGenerator.generate(
        "You are a conversation summarizer. Extend the existing summary with the new messages. " +
          "Preserve: facts, decisions, corrections, user preferences, tool outcomes. " +
          "Discard: pleasantries, filler. Collapse tool calls into prose. " +
          "Return only the updated summary text.",
        `Existing summary:\n${currentSummary ?? "(none)"}\n\n` +
          `New messages to incorporate:\n${formatMessagesForPrompt(toCompress)}`,
      );

      await Promise.all([
        this.conversationRepo.upsertSummary(conversationId, newSummary),
        this.messageRepo.markCompressed(
          toCompress.map((m) => m.id),
          newCurrentUTCEpoch(),
        ),
      ]);

      currentSummary = newSummary;
    }

    recentMessages = tail;
  } else {
    recentMessages = uncompressed.slice(-20);
  }

  // ─── PHASE 2: BUILD SLIDING WINDOW ────────────────────────────────────────
  const slidingWindow: IOrchestratorMessage[] = [];

  if (currentSummary) {
    slidingWindow.push({
      role: MESSAGE_ROLE.ASSISTANT,
      content: `Summary of earlier conversation:\n${currentSummary}`,
    });
  }

  // buildOrchestratorHistory already exists in the current codebase. It maps Message[]
  // to IOrchestratorMessage[] and sanitizes incomplete ASSISTANT_TOOL_CALL/TOOL pairs
  // (drops tool call messages where the corresponding TOOL result is missing, which can
  // happen on a crash mid-execution). Keep it as-is.
  slidingWindow.push(...this.buildOrchestratorHistory(recentMessages));

  // ─── PHASE 4: SYSTEM PROMPT ───────────────────────────────────────────────
  const basePrompt = config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const systemPrompt = this.buildSystemPrompt(
    basePrompt,
    userProfile?.personalities ?? [],
    relevantMemories,
  );

  // ─── PHASE 5+6: IMAGE + USER MESSAGE + AGENTIC LOOP ─────────────────────
  slidingWindow.push({
    role: MESSAGE_ROLE.USER,
    content: input.message,
    imageBase64Url: input.imageBase64Url,
  });

  const toolRegistry = this.registryFactory(input.userId);
  const availableTools = toolRegistry.getAll().map((t) => t.definition());
  const toolsUsed: IToolResult[] = [];
  let finalReply = "";
  let lastUsage: { promptTokens: number; completionTokens: number } | undefined;

  for (let round = 0; round < maxRounds; round++) {
    const llmResponse = await this.orchestrator.chat({
      systemPrompt,
      conversationHistory: slidingWindow,
      availableTools,
    });

    lastUsage = llmResponse.usage;

    if (!llmResponse.toolCalls?.length) {
      finalReply = llmResponse.text ?? "";
      break;
    }

    // All tool calls in a single round are independent — OpenAI groups them that way.
    const roundResults = await Promise.all(
      llmResponse.toolCalls.map((tc) => this.executeTool(tc, toolRegistry)),
    );

    // Persist tool calls + all results concurrently
    const toolCallsJson = JSON.stringify(llmResponse.toolCalls);
    await Promise.all([
      this.messageRepo.create({
        id: newUuid(),
        conversationId,
        role: MESSAGE_ROLE.ASSISTANT_TOOL_CALL,
        content: "",
        toolCallsJson,
        createdAtEpoch: newCurrentUTCEpoch(),
      }),
      ...roundResults.map((r) =>
        this.messageRepo.create({
          id: newUuid(),
          conversationId,
          role: MESSAGE_ROLE.TOOL,
          content: JSON.stringify(r.result.data ?? r.result.error),
          toolName: r.toolName as TOOL_TYPE,
          toolCallId: r.toolCallId,
          createdAtEpoch: newCurrentUTCEpoch(),
        }),
      ),
    ]);

    slidingWindow.push({ role: MESSAGE_ROLE.ASSISTANT_TOOL_CALL, content: "", toolCallsJson });
    for (const r of roundResults) {
      slidingWindow.push({
        role: MESSAGE_ROLE.TOOL,
        content: JSON.stringify(r.result.data ?? r.result.error),
        toolName: r.toolName,
        toolCallId: r.toolCallId,
      });
    }

    toolsUsed.push(...roundResults);
  }

  // ─── PHASE 7: PERSIST ASSISTANT RESPONSE ─────────────────────────────────
  const messageId = newUuid();
  await this.messageRepo.create({
    id: messageId,
    conversationId,
    role: MESSAGE_ROLE.ASSISTANT,
    content: finalReply,
    createdAtEpoch: newCurrentUTCEpoch(),
  });

  // ─── PHASE 8+9: NON-BLOCKING POST-PROCESSING ─────────────────────────────
  setImmediate(() => {
    void this.postProcess({
      conversationId,
      messageId,
      userId: input.userId,
      systemPrompt,
      relevantMemories,
      toolsUsed,
      finalReply,
      usage: lastUsage,
      slidingWindow,
      totalTokens,
      userMessage: input.message,
    });
  });

  return {
    conversationId,
    messageId,
    reply: finalReply,
    toolsUsed: toolsUsed.map((t) => t.toolName),
  };
}
```

### 7g — `initConversation()` — creates conversation only

No user message persist here. That moved to the parallel batch in `chat()`.

```typescript
private async initConversation(input: IChatInput): Promise<string> {
  if (input.conversationId) return input.conversationId;

  const conversationId = newUuid();
  const now = newCurrentUTCEpoch();
  await this.conversationRepo.create({
    id: conversationId,
    userId: input.userId,
    title: input.message.slice(0, 60),
    status: CONVERSATION_STATUSES.ACTIVE,
    flaggedForCompression: false,
    createdAtEpoch: now,
    updatedAtEpoch: now,
  });
  return conversationId;
}
```

### 7h — `searchRelevantMemories()`

```typescript
private async searchRelevantMemories(
  message: string,
  userId: string,
): Promise<IVectorQueryResult[]> {
  try {
    const { vector } = await this.embeddingService.embed({ text: message });
    const results = await this.vectorStore.query(vector, 5, { userId });
    return results.filter((r) => r.score >= 0.75);
  } catch {
    return [];
  }
}
```

### 7i — `buildSystemPrompt()` — synchronous, takes resolved data

Replaces the old async `buildSystemPrompt(userId, basePrompt)`. The new version is synchronous
because all data is already resolved from the parallel batch.

```typescript
private buildSystemPrompt(
  basePrompt: string,
  personalities: string[],
  memories: IVectorQueryResult[],
): string {
  const now = new Date();
  const parts: string[] = [basePrompt];

  if (personalities.length > 0) {
    parts.push(`Personality: ${personalities.join(", ")}.`);
  }

  parts.push(`Current datetime: ${now.toISOString()}.`);

  if (memories.length > 0) {
    const formatted = memories
      .map((m, i) => `${i + 1}. ${String(m.metadata["content"] ?? "")}`)
      .join("\n");
    parts.push(`Relevant memories about the user:\n${formatted}`);
  }

  parts.push(
    `REASONING INSTRUCTIONS:
Before calling any tool, emit a Thought explaining:
- What the user is actually asking (decompose if multiple things)
- What information you need
- Which tools you will use and in what order
- What you will do if a tool returns empty or errors

After receiving tool results, emit another Thought:
- What the result tells you
- Whether you need another tool or can respond
- If result is empty/error, reason about an alternative approach

Never skip the Thought step.`,
  );

  return parts.join("\n\n");
}
```

### 7j — `executeTool()` — single transient retry

```typescript
private async executeTool(
  call: IToolCall,
  toolRegistry: IToolRegistry,
): Promise<IToolResult> {
  const start = Date.now();
  const tool = toolRegistry.getByName(call.toolName as TOOL_TYPE);

  if (!tool) {
    return {
      toolCallId: call.id,
      toolName: call.toolName,
      params: call.input,
      result: { success: false, error: `Tool "${call.toolName}" is not available.` },
      latencyMs: Date.now() - start,
    };
  }

  let result = await tool.execute(call.input);

  if (!result.success) {
    // Single retry with identical params — handles transient failures only.
    // Param errors are not corrected here; the LLM sees the error result and
    // may issue a corrected call on the next loop round.
    result = await tool.execute(call.input);
  }

  return {
    toolCallId: call.id,
    toolName: call.toolName,
    params: call.input,
    result,
    latencyMs: Date.now() - start,
  };
}
```

### 7k — `postProcess()` — all async post-turn work

```typescript
private async postProcess(ctx: {
  conversationId: string;
  messageId: string;
  userId: string;
  systemPrompt: string;
  relevantMemories: IVectorQueryResult[];
  toolsUsed: IToolResult[];
  finalReply: string;
  usage: { promptTokens: number; completionTokens: number } | undefined;
  slidingWindow: IOrchestratorMessage[];
  totalTokens: number;
  userMessage: string;
}): Promise<void> {
  try {
    // Phase 8 — evaluation log
    const logId = newUuid();
    await this.evaluationLogRepo.create({
      id: logId,
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      userId: ctx.userId,
      systemPromptHash: hashString(ctx.systemPrompt),
      memoriesInjected: JSON.stringify(
        ctx.relevantMemories.map((m) => ({ id: m.id, score: m.score })),
      ),
      toolCalls: JSON.stringify(ctx.toolsUsed),
      reasoningTrace: buildReasoningTrace(ctx.toolsUsed),
      response: ctx.finalReply,
      promptTokens: ctx.usage?.promptTokens ?? null,
      completionTokens: ctx.usage?.completionTokens ?? null,
      implicitSignal: null,
      explicitRating: null,
      outcomeConfirmed: null,
      createdAtEpoch: newCurrentUTCEpoch(),
    });

    // Phase 8b — detect implicit signal on PREVIOUS turn's log row
    const prevLog = await this.evaluationLogRepo.findLastByConversation(
      ctx.conversationId,
      1,
    );
    if (prevLog) {
      const signal = detectImplicitSignal(ctx.userMessage, prevLog.response);
      if (signal) {
        await this.evaluationLogRepo.updateImplicitSignal(prevLog.id, signal);
      }
    }

    // Phase 9a — memory extraction
    // Skip trivial turns (short reply, no tools) to avoid unnecessary LLM + embedding calls.
    // NOTE: when facts are extracted, each requires a separate embeddingService.embed() call
    // (up to 5 parallel calls per qualifying turn in the async path).
    const skipMemoryExtraction =
      ctx.finalReply.length < 100 && ctx.toolsUsed.length === 0;

    if (!skipMemoryExtraction) {
      const rawFacts = await this.textGenerator.generate(
        "Extract facts worth remembering about the user from this exchange. " +
          "Only extract if genuinely new or correcting existing knowledge. " +
          "Return a JSON array of objects with 'content' (string) and 'category' (string) fields. " +
          "If nothing worth remembering, return [].",
        formatMessagesForPrompt(
          ctx.slidingWindow.slice(-4).map((m) => ({
            role: m.role,
            content: m.content,
          })),
        ),
      );

      let facts: { content: string; category?: string }[] = [];
      try {
        const parsed = JSON.parse(rawFacts);
        if (Array.isArray(parsed)) facts = parsed;
      } catch {
        // malformed JSON — skip memory extraction this turn
      }

      if (facts.length > 0) {
        await Promise.all(
          facts.map(async (f) => {
            const pineconeId = newUuid();
            const { vector } = await this.embeddingService.embed({ text: f.content });
            const now = newCurrentUTCEpoch();
            await Promise.all([
              this.vectorStore.upsert({
                id: pineconeId,
                vector,
                metadata: {
                  content: f.content,
                  userId: ctx.userId,
                  category: f.category ?? "",
                },
              }),
              this.userMemoryRepo.create({
                id: newUuid(),
                userId: ctx.userId,
                content: f.content,
                category: f.category,
                pineconeId,
                createdAtEpoch: now,
                updatedAtEpoch: now,
                lastAccessedEpoch: now,
              }),
            ]);
          }),
        );
      }
    }

    // Phase 9b — intent update
    const intent = await this.textGenerator.generate(
      "Summarize what this conversation is about in one sentence.",
      formatMessagesForPrompt(
        ctx.slidingWindow.slice(-6).map((m) => ({
          role: m.role,
          content: m.content,
        })),
      ),
    );
    await this.conversationRepo.updateIntent(ctx.conversationId, intent);

    // Phase 9c — compression threshold warning
    const newTokenEstimate =
      ctx.totalTokens +
      Math.ceil(ctx.userMessage.length / 4) +
      Math.ceil(ctx.finalReply.length / 4);
    if (newTokenEstimate > 70_000) {
      await this.conversationRepo.flagForCompression(ctx.conversationId);
    }
  } catch (err) {
    console.error("[assistant] postProcess error:", err);
  }
}
```

### 7l — Delete old private methods

Remove these two private methods from the old implementation — they are fully replaced:
- `buildSystemPrompt(userId: string, basePrompt: string): Promise<string>` (async, fetched user from DB)
- `loadChatConfig(userId: string)` (loaded config + called old buildSystemPrompt)

### 7m — Keep `buildOrchestratorHistory()` unchanged

This existing private method is still used in `chat()`. Do not modify it.

---

## Step 8 — Update DI Container

**File:** `src/adapters/inject/assistant.di.ts`

### 8a — New import

Add one import (the others are already present):
```typescript
import { DrizzleEvaluationLogRepo } from "../implementations/output/sqlDB/repositories/evaluationLog.repo";
```

The `IUserProfileDB` type import is not needed — `sqlDB.userProfiles` is already typed as
`DrizzleUserProfileRepo` which implements `IUserProfileDB`.

### 8b — Wire new constructor args

Replace the `new AssistantUseCaseImpl(...)` call. The current last argument is `sqlDB.users`.
Replace the entire instantiation:

```typescript
this.useCase = new AssistantUseCaseImpl(
  speechToText,
  orchestrator,
  registryFactory,
  sqlDB.conversations,
  sqlDB.messages,
  jarvisConfigRepo,
  sqlDB.userProfiles,       // was: sqlDB.users
  embeddingService,          // new
  vectorStore,               // new
  enrichmentGenerator,       // new — already instantiated as OpenAITextGenerator(apiKey, "gpt-4o-mini")
  sqlDB.evaluationLogs,      // new — added by Batch 2
  sqlDB.userMemories,        // new
);
```

---

## Edge Cases

- **New conversation** — `allMessages` is empty, `totalTokens = 0`, no compression, no summary.
  Sliding window starts with just the pushed user message.

- **`allMessages.length <= 20`** — `uncompressed.slice(-20)` returns all of them. Token count is
  low, compression does not trigger.

- **Compression triggered but `toCompress` is empty** — guarded by `if (toCompress.length > 0)`
  before calling `textGenerator`. Happens when all uncompressed messages fit in the tail window.

- **`conversation` is null** — use `conversation?.summary ?? null` and
  `conversation?.flaggedForCompression` defaulting to `false`. Possible only on brand-new
  conversations if `findById` races with `create`.

- **Memory search throws** — `searchRelevantMemories` wraps embed+query in try/catch, returns `[]`.
  The pipeline continues with no memories injected.

- **`postProcess` throws** — wrapped in outer try/catch, logged. Never propagates to the caller.

- **`textGenerator` returns malformed JSON** — try/catch around `JSON.parse` in Phase 9a.
  Falls through with `facts = []`, no memories extracted that turn.

---

## Verification

1. **Basic chat** — send a message in a new conversation. Confirm:
   - Assistant replies
   - `evaluation_logs` has one row with non-null `system_prompt_hash`, `response`, and `created_at_epoch`
   - `conversations.intent` is populated after the turn

2. **Compression** — temporarily lower `DEFAULT_MAX_TOOL_ROUNDS` to force many messages, or insert
   enough messages to exceed 80k tokens, then send a message. Confirm:
   - Older messages have `compressed_at_epoch` set
   - `conversations.summary` is populated
   - The 20 most recent messages remain uncompressed

3. **Sliding window after compression** — send another message in the same conversation. Confirm
   via `[assistant]` logs that the summary appears as the first entry in `conversationHistory`.

4. **Memory injection** — insert a `user_memories` row with a Pinecone vector for the test user.
   Send a semantically matching message. Confirm the system prompt log includes the memory text.

5. **Parallel tool execution** — send a query that triggers two tool calls in one round. Confirm
   both fire with overlapping timestamps (check `latencyMs` in the evaluation log's `tool_calls`
   JSON) and both results appear in the sliding window.

6. **Evaluation log completeness** — after a tool-using turn, read the `evaluation_logs` row.
   Confirm `tool_calls` JSON is populated, `memories_injected` reflects Phase 3 results,
   `reasoning_trace` shows the step sequence, and `prompt_tokens`/`completion_tokens` are non-null.

7. **Implicit signal** — send "actually, that's wrong" immediately after any assistant reply.
   Confirm the **previous** `evaluation_logs` row (not the current one) has
   `implicit_signal = 'correction'`.

8. **Compression threshold warning** — in a conversation where the post-turn token estimate exceeds
   70k, confirm `conversations.flagged_for_compression = true` is set. On the next turn, confirm
   compression triggers even if `totalTokens` is between 70k and 80k.
