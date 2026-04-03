# Orchestration Upgrade — Batch 0: Pre-flight Checklist

## What this batch does

Read-only verification. Confirms that every interface, method, and variable that Batches 1–3
assume already exist actually exist in the current codebase. Fix any gaps before starting Batch 1.

**After this batch:** all boxes checked. No compilation step needed — this is inspection only.

---

## Checklist

For each item: read the listed file, confirm the check passes, mark it done.

### `IUserProfileDB` — used in Batch 3 constructor, replaces `IUserDB`

**File:** `src/use-cases/interface/output/repository/userProfile.repo.ts`

- [ ] Interface `IUserProfileDB` is exported
- [ ] Method `findByUserId(userId: string): Promise<IUserProfile | null>` exists
- [ ] `IUserProfile` has a `personalities: string[]` field

### `IVectorQueryResult` — used in Batch 3 `searchRelevantMemories()` and `buildSystemPrompt()`

**File:** `src/use-cases/interface/output/vectorDB.interface.ts`

- [ ] Interface `IVectorQueryResult` is exported
- [ ] Has field `id: string`
- [ ] Has field `score: number`
- [ ] Has field `metadata: Record<string, string | number | boolean>`

### `IVectorStore` — used in Batch 3 constructor and `searchRelevantMemories()`

**File:** `src/use-cases/interface/output/vectorDB.interface.ts`

- [ ] Interface `IVectorStore` is exported
- [ ] Method `query(vector: number[], topK: number, filter?: Record<string, string>)` exists
- [ ] Method `upsert(record: IVectorStoreRecord)` exists

### `IToolRegistry.getByName()` — used in Batch 3 `executeTool()`

**File:** `src/use-cases/interface/output/tool.interface.ts`

- [ ] Interface `IToolRegistry` is exported
- [ ] Method `getByName(name: TOOL_TYPE): ITool | undefined` (or equivalent) exists
- [ ] Method `getAll(): ITool[]` exists

### `IUserMemoryDB.create()` — used in Batch 3 `postProcess()`

**File:** `src/use-cases/interface/output/repository/userMemory.repo.ts`

- [ ] Interface `IUserMemoryDB` is exported
- [ ] Method `create(memory: UserMemory): Promise<void>` exists
- [ ] `UserMemory` has fields: `id`, `userId`, `content`, `category?`, `pineconeId`,
  `createdAtEpoch`, `updatedAtEpoch`, `lastAccessedEpoch`

### `ITextGenerator` — used in Batch 3 constructor and `postProcess()`

**File:** `src/use-cases/interface/output/textGenerator.interface.ts`

- [ ] Interface `ITextGenerator` is exported
- [ ] Method `generate(systemPrompt: string, userPrompt: string): Promise<string>` exists

### `IEmbeddingService` — used in Batch 3 constructor and `searchRelevantMemories()`

**File:** `src/use-cases/interface/output/embedding.interface.ts`

- [ ] Interface `IEmbeddingService` is exported
- [ ] Method `embed(input: { text: string }): Promise<{ vector: number[]; tokenCount: number }>` exists

### `IChatInput` — used in Batch 3 `chat()` and `initConversation()`

**File:** `src/use-cases/interface/input/assistant.interface.ts`

- [ ] Interface `IChatInput` is exported
- [ ] Has field `userId: string`
- [ ] Has field `message: string`
- [ ] Has field `conversationId?: string` (optional)
- [ ] Has field `imageBase64Url?: string` (optional)

### `IChatResponse` — return type of `chat()`

**File:** `src/use-cases/interface/input/assistant.interface.ts`

- [ ] Interface `IChatResponse` is exported
- [ ] Has fields: `conversationId`, `messageId`, `reply`, `toolsUsed`

### `buildOrchestratorHistory()` — called in Batch 3 `chat()`, must not be deleted

**File:** `src/use-cases/implementations/assistant.usecase.ts`

- [ ] Private method `buildOrchestratorHistory(messages: Message[]): IOrchestratorMessage[]` exists
- [ ] It filters out `ASSISTANT_TOOL_CALL` messages where the corresponding `TOOL` result is missing

### `enrichmentGenerator` variable name — passed as `ITextGenerator` in Batch 3 DI wiring

**File:** `src/adapters/inject/assistant.di.ts`

- [ ] A variable named `enrichmentGenerator` exists inside `getUseCase()`
- [ ] It is an instance of `OpenAITextGenerator` (or equivalent `ITextGenerator` implementation)
- [ ] Confirm the exact variable name — Batch 3 Step 8b passes it as the `textGenerator` arg

### `sqlDB.userProfiles` — Batch 3 passes this instead of `sqlDB.users`

**File:** `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts`

- [ ] Property `userProfiles` exists on `DrizzleSqlDB`
- [ ] It is an instance of `DrizzleUserProfileRepo` (which implements `IUserProfileDB`)

### `sqlDB.userMemories` — passed as `IUserMemoryDB` in Batch 3

**File:** `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts`

- [ ] Property `userMemories` exists on `DrizzleSqlDB`
- [ ] It implements `IUserMemoryDB`

### `PineconeVectorStore` — the `vectorStore` variable passed in Batch 3

**File:** `src/adapters/inject/assistant.di.ts`

- [ ] A variable named `vectorStore` exists inside `getUseCase()`
- [ ] It is passed to tool constructors today (e.g. `RetrieveUserMemoryTool`, `StoreUserMemoryTool`)
- [ ] Confirm it is in scope at the point where `new AssistantUseCaseImpl(...)` is called

### `embeddingService` variable name — passed as `IEmbeddingService` in Batch 3

**File:** `src/adapters/inject/assistant.di.ts`

- [ ] A variable named `embeddingService` exists inside `getUseCase()`
- [ ] Confirm the exact variable name — Batch 3 Step 8b passes it directly

---

## If a check fails

| Failure | Action |
|---------|--------|
| Interface missing entirely | Create it before starting Batch 1 |
| Method signature differs from what Batch 3 expects | Update the relevant Batch 3 step to match the actual signature |
| Variable name in DI differs | Update Step 8b in `orchestration-batch-3-business-logic.md` to use the correct name |
| `buildOrchestratorHistory()` missing | Add it to Batch 3's work — it maps `Message[]` to `IOrchestratorMessage[]` and filters incomplete tool call pairs |
