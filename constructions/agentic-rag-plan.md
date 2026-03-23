# Agentic RAG Implementation Plan

## Context

JARVIS/Memora has no working RAG system — a prior implementation was deleted and the OpenAI orchestrator currently throws `"not yet implemented"`. The goal is to add an **agentic RAG** system where the LLM decides when to retrieve or store user memories (via tool calls), rather than a fixed pre-retrieval step. This is the most appropriate pattern for a personal assistant because:
- Not every message needs retrieval ("what's 2+2?" should not hit a vector store)
- The tool loop architecture already exists as a skeleton — this plan completes it
- Pinecone (`@pinecone-database/pinecone`) and OpenAI (`openai`) SDKs are already installed

---

## Execution Order (each step unblocks the next)

### Step 1 — Implement `OpenAIOrchestrator.chat()` ⚡ (blocker for everything)

**File:** `src/adapters/implementations/output/llmOrchestrator/openai.llmOrchestrator.ts`

- Create an `OpenAI` client in the constructor (`new OpenAI({ apiKey })`)
- Map `IOrchestratorMessage[]` → `ChatCompletionMessageParam[]`:
  - `ASSISTANT_TOOL_CALL` role (added in Step 2) → `{ role: "assistant", tool_calls: JSON.parse(msg.toolCallsJson) }`
  - `TOOL` role → `{ role: "tool", tool_call_id: msg.toolCallId, content: msg.content }`
  - All others → `{ role: msg.role, content: msg.content }`
- Map `IToolDefinition[]` → `ChatCompletionTool[]` (name, description, parameters from `inputSchema`)
- Call `client.chat.completions.create({ model, messages, tools, tool_choice: "auto" })`
- If response has `tool_calls` → return `{ toolCalls: [...] }`; else return `{ text: message.content }`
- Add `toolCallsJson?: string` to `IOrchestratorMessage` in `src/use-cases/interface/output/llmOrchestrator.interface.ts`

### Step 2 — Add `ASSISTANT_TOOL_CALL` to `MESSAGE_ROLE` enum

**File:** `src/helpers/enums/messageRole.enum.ts`

Add `ASSISTANT_TOOL_CALL = "assistant_tool_call"` — this role marks an assistant message that contains tool call intent (no text). Needed to round-trip the OpenAI `tool_calls` array through the DB (OpenAI rejects history where tool results have no preceding assistant tool-call message).

### Step 3 — Extend DB schema + run migration

**File:** `src/adapters/implementations/output/sqlDB/schema.ts`

**Add nullable column to existing `messages` table:**
```typescript
toolCallsJson: text("tool_calls_json"),  // JSON of IToolCall[] when role = assistant_tool_call
```

**Add new table:**
```typescript
export const userMemories = pgTable("user_memories", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  content: text("content").notNull(),          // raw content as provided by the LLM
  enrichedContent: text("enriched_content"),   // contextually enriched version used for embedding (see Step 7)
  category: text("category"),                  // "preference" | "fact" | "event" | "goal"
  pineconeId: text("pinecone_id").notNull(),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
  lastAccessedEpoch: integer("last_accessed_epoch").notNull(), // updated on every retrieval; foundation for TTL/LRU eviction
});
```

Run: `npm run db:generate && npm run db:migrate`

### Step 4 — Add `IUserMemoryDB` interface + `DrizzleUserMemoryRepo`

**New interface:** `src/use-cases/interface/output/repository/userMemory.repo.ts`
```typescript
interface IUserMemoryDB {
  create(memory: UserMemory): Promise<void>;
  update(memory: UserMemory): Promise<void>;           // used for deduplication (see Step 7)
  findByPineconeId(pineconeId: string): Promise<UserMemory | undefined>;
  findByUserId(userId: string): Promise<UserMemory[]>;
  updateLastAccessed(id: string, epoch: number): Promise<void>; // called on every retrieval hit
  deleteById(id: string): Promise<void>;
}
```

**New implementation:** `src/adapters/implementations/output/sqlDB/repositories/userMemory.repo.ts`
- Follow the same Drizzle pattern as `DrizzleMessageRepo` (constructor takes `NodePgDatabase`)
- Add `DrizzleUserMemoryRepo` to the `DrizzleSqlDB` adapter as a property

### Step 5 — Add `IEmbeddingService` interface + `OpenAIEmbeddingService`

**New interface:** `src/use-cases/interface/output/embeddingService.interface.ts`
```typescript
interface IEmbeddingService {
  embed(input: { text: string }): Promise<{ vector: number[]; tokenCount: number }>;
}
```

**New implementation:** `src/adapters/implementations/output/embeddingService/openai.embeddingService.ts`
- Use `text-embedding-3-small` with `dimensions: 1536`
- Create client via `new OpenAI({ apiKey })`
- Call `client.embeddings.create({ model, input: text, dimensions: 1536 })`

> ⚠️ **Pinecone index must be created with `dimension: 1536`** before first use — cannot be changed later.

### Step 6 — Add `IVectorStore` interface + `PineconeVectorStore`

**New interface:** `src/use-cases/interface/output/vectorStore.interface.ts`
```typescript
interface IVectorStore {
  upsert(record: { id: string; vector: number[]; metadata: Record<string, string | number | boolean> }): Promise<void>;
  query(vector: number[], topK: number, filter?: Record<string, string>): Promise<{ id: string; score: number; metadata: Record<string, string | number | boolean> }[]>;
  delete(id: string): Promise<void>;
}
```

**New implementation:** `src/adapters/implementations/output/vectorStore/pinecone.vectorStore.ts`
- Constructor: `new Pinecone({ apiKey })`, expose `this.client.index(indexName)`
- Every `upsert()` call must include `userId` in metadata for per-user filtering
- Every `query()` call must pass `filter: { userId }` to prevent cross-user memory leakage

### Step 7 — Add two TOOL_TYPE values + implement RAG tools

**File to modify:** `src/helpers/enums/toolType.enum.ts`
```typescript
RETRIEVE_USER_MEMORY = "retrieve_user_memory",
STORE_USER_MEMORY = "store_user_memory",
```

**New:** `src/adapters/implementations/output/tools/retrieveUserMemory.tool.ts`
- Input schema: `{ query: string, topK?: number }`
- Logic: embed `query` → `vectorStore.query(vector, topK ?? 5, { userId })` → format results as numbered list → call `userMemoryRepo.updateLastAccessed()` for each returned hit
- Constructor args: `userId, embeddingService, vectorStore, userMemoryRepo`

**New:** `src/adapters/implementations/output/tools/storeUserMemory.tool.ts`
- Input schema: `{ content: string, category?: string }`
- Logic:
  1. **Contextual enrichment** — call a cheap LLM pass (e.g. `gpt-4o-mini`) to rewrite the raw content into a fuller, self-contained statement. Example: `"I prefer dark mode"` → `"User interface preference: the user prefers dark mode across all applications"`. Store the raw string as `content` and the enriched string as `enrichedContent`. Embed the enriched string.
  2. **Deduplication** — before inserting, call `vectorStore.query(enrichedVector, 1, { userId })`. If the top result has `score > 0.92`, update the existing record (Pinecone upsert by same ID + `userMemoryRepo.update()`) instead of inserting a new one.
  3. If no duplicate found: generate `pineconeId = newUuid()` → `vectorStore.upsert(...)` → `userMemoryRepo.create(...)`
- Constructor args: `userId, embeddingService, vectorStore, userMemoryRepo, llmClient` (lightweight OpenAI client for enrichment)

> ⚠️ **`userId` is injected at construction time** (per-request registry, see Step 9). Do not thread it through `IToolInput`.

### Step 8 — Fix multi-turn agentic loop + personality injection in `AssistantUseCaseImpl`

**File:** `src/use-cases/implementations/assistant.usecase.ts`

**Multi-turn loop (replaces the current single-pass TODO):**

`MAX_TOOL_ROUNDS` is not hardcoded — read it from `jarvis_config` or fall back to the env var `MAX_TOOL_ROUNDS` (default `10`). Add this field to `JarvisConfig` and `IJarvisConfigDB` accordingly.

Load history **once before the loop**, then append new messages in-memory during each round. Persist all new messages to the DB **after the loop exits** (or immediately per-message for durability — choose based on whether partial recovery on crash matters). This avoids N DB round-trips per tool round.

```
const history = await loadHistory(conversationId);  // single DB read before loop

for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
  const result = await orchestrator.chat({ systemPrompt, history, tools });

  if no toolCalls → persist ASSISTANT message → return response

  persist ASSISTANT_TOOL_CALL message (with toolCallsJson)
  history.push(assistantToolCallMessage);           // append in-memory

  for each toolCall → execute → persist TOOL message → history.push(toolResultMessage)
  // loop: history now contains tool results, next call sees them
}
// fallback if rounds exhausted
```

**`buildOrchestratorHistory()`** private method:
- Maps `Message[]` → `IOrchestratorMessage[]`
- For `ASSISTANT_TOOL_CALL` messages: include `toolCallsJson` so Step 1's orchestrator can reconstruct the OpenAI-format tool_calls message

**`buildSystemPrompt()`** async private method:
- Load user via `this.userRepo.findById(userId)` (already exists in `DrizzleUserRepo`)
- Append personality context: `"Personality: primary — calm, analytical. Secondary — thorough."`
- Add constructor dependency: `IUserDB`

**Update `IMessageDB.create()`** to accept optional `toolCallsJson?: string`, and update `DrizzleMessageRepo` to persist/retrieve it.

### Step 9 — Per-request tool registry + DI wiring

**File:** `src/adapters/inject/assistant.di.ts`

**Services created as singletons** (constructor of `AssistantInject`):
- `OpenAIEmbeddingService(OPENAI_API_KEY)`
- `PineconeVectorStore(PINECONE_API_KEY, PINECONE_INDEX_NAME)`
- `DrizzleUserMemoryRepo(db)`

**Remove `IToolRegistry` from `AssistantUseCaseImpl` constructor** — instead inject the individual tool dependencies. The use case builds a fresh registry per `chat()` call:

```typescript
private buildToolRegistry(userId: string): IToolRegistry {
  const r = new ToolRegistryConcrete();
  r.register(new WebSearchTool());
  r.register(new SendEmailTool(this.emailSender));
  r.register(new CalendarTool());
  r.register(new ReminderTool());
  r.register(new RetrieveUserMemoryTool(userId, this.embeddingService, this.vectorStore));
  r.register(new StoreUserMemoryTool(userId, this.embeddingService, this.vectorStore, this.userMemoryRepo));
  return r;
}
```

### Step 10 — Environment variables

**File:** `.env.example` — add:
```
PINECONE_API_KEY=...
PINECONE_INDEX_NAME=memora-user-memories
```

Create the Pinecone index manually (dashboard or CLI) with:
- Dimension: `1536`, Metric: `cosine`, Cloud: serverless

---

## Critical Files

| File | Action |
|------|--------|
| `src/adapters/implementations/output/llmOrchestrator/openai.llmOrchestrator.ts` | Implement (Step 1) |
| `src/use-cases/interface/output/llmOrchestrator.interface.ts` | Add `toolCallsJson?` to `IOrchestratorMessage` |
| `src/helpers/enums/messageRole.enum.ts` | Add `ASSISTANT_TOOL_CALL` (Step 2) |
| `src/helpers/enums/toolType.enum.ts` | Add 2 RAG types (Step 7) |
| `src/adapters/implementations/output/sqlDB/schema.ts` | Extend messages + add userMemories (Step 3) |
| `src/use-cases/interface/output/repository/userMemory.repo.ts` | New interface (Step 4) |
| `src/adapters/implementations/output/sqlDB/repositories/userMemory.repo.ts` | New impl (Step 4) |
| `src/use-cases/interface/output/embeddingService.interface.ts` | New interface (Step 5) |
| `src/adapters/implementations/output/embeddingService/openai.embeddingService.ts` | New impl (Step 5) |
| `src/use-cases/interface/output/vectorStore.interface.ts` | New interface (Step 6) |
| `src/adapters/implementations/output/vectorStore/pinecone.vectorStore.ts` | New impl (Step 6) |
| `src/adapters/implementations/output/tools/retrieveUserMemory.tool.ts` | New tool (Step 7) |
| `src/adapters/implementations/output/tools/storeUserMemory.tool.ts` | New tool (Step 7) |
| `src/use-cases/implementations/assistant.usecase.ts` | Fix loop + personality injection (Step 8) |
| `src/adapters/inject/assistant.di.ts` | Wire all new dependencies (Step 9) |

---

## Verification

1. **Smoke test** — after Step 1, use `src/jarvisCli.ts` or `src/consoleCli.ts` to send a basic message and confirm the orchestrator returns a text reply without throwing
2. **Tool execution test** — send "search the web for TypeScript news" and confirm the multi-turn loop calls the tool and returns a final text response
3. **Memory store test** — send "Remember that I prefer dark mode" → confirm `store_user_memory` fires, a row appears in `user_memories`, and a vector is written to Pinecone
4. **Memory retrieval test** — in a new conversation, ask "what are my preferences?" → confirm `retrieve_user_memory` fires and the response includes "dark mode"
5. **Personality injection test** — assign personalities to a user in the DB, start a conversation, confirm the system prompt includes the personality description
6. **Cross-user isolation test** — store a memory for user A, query as user B → confirm no results returned
