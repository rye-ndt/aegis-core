# Context

## 2026-02-06

- Initialized analysis of the Hexagonal Architecture project.
- User is implementing a "Store Data" feature with `Agent` capabilities.
- Added `SUPPORTED_FUNCTIONS` enum. Primary categories live in `src/helpers/enums/categories.enum.ts` as `PRIMARY_CATEGORY`.
- Modified `Agent` entity to include supported methods.
- Installed `uuid` and `@types/uuid` packages.
- Fixed `IStoreData.ts` interface definition.

## 2026-02-07

- Configured ESLint (v9 flat config) and Prettier for the project.
- Installed `eslint`, `prettier`, `typescript-eslint`, `eslint-config-prettier`, `eslint-plugin-prettier`, `globals`.
- Created `eslint.config.mjs` and `.prettierrc`.
- Updated `.vscode/settings.json` to enable format on save with ESLint fixing.
- Added `lint`, `lint:fix`, `format` scripts to `package.json`.
- Ran `npm run lint:fix` to clean up existing code; found 7 remaining logic errors (unused vars) and 2 warnings.
- Resolved linting/formatting conflicts by removing `eslint-plugin-prettier` and relying on `eslint-config-prettier` + standalone Prettier.
- Increased Prettier `printWidth` to 120 to reduce aggressive line wrapping.
- Updated VS Code settings to use `esbenp.prettier-vscode` as the default formatter.
- Installed `uuid` v4 (verified presence) and replaced `crypto` usage for UUIDs.
- Updated `IStoreData.ts` to use `string` for ID types instead of `crypto.UUID`, and resolved missing import issue.
- Updated `StoreUserInput.ts` to import `uuidv4`, fixed syntax errors, and implemented `processAndStore` with correct return types and error handling.
- Validated `npm run build` passes for modified files (although other files have unrelated errors).

## Risks

- `IStoreData.ts` was in a broken state, assumed `id` is string and `store` returns Promise.
- `payload` made optional in `IStoreData.ts` to resolve build error in `StoreUserInput.ts`.

## 2026-02-15

- Categorizer: `V1Categorizer` in `src/adapters/implementations/output/categorizer/v1.categorizer.ts` uses OpenAI SDK `chat.completions.parse()` with `zodResponseFormat` for structured output. Config: `{ model, apiKey }`. Returns `CategorizedItem` (category from `PRIMARY_CATEGORY`, tags string[]). Requires GPT-4o or later for structured outputs. Dependencies: `openai`, `zod`.
- PostgresDB: Base Postgres adapter in `src/adapters/implementations/output/sqlDB/drizzlePostgres.db.ts`. Drizzle ORM + `pg` driver. Config: `connectionString` or `{ host, port?, user, password, database }`. Subclasses use `protected get db` (NodePgDatabase) for queries. `close()` ends the pool. Schema: `sqlDB/schema.ts`; migrations: `drizzle.config.ts`, scripts `db:generate`, `db:migrate`, `db:push`, `db:studio`. Env: `DATABASE_URL`.
- SQL ports (table repos): `src/use-cases/interface/output/sqlDB.interface.ts` defines per-table repository ports (example: `IOriginalNoteDB`) and an `ISqlDB` facade. Drizzle adapter facade `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` owns one DB connection and exposes repositories (example: `repositories/originalNote.repo.ts`). Example consumption: `src/use-cases/implementations/storeOriginalNote.usecase.ts`.
- Hex layout cleanup: `src/use-cases/interface/input/` is now **inbound ports**, `src/use-cases/interface/output/` is **outbound ports**, and `src/use-cases/interface/shared/` holds shared DTOs/errors. Driven adapters were moved under `src/adapters/implementations/output/` (db/llm/vector/chunker/categorizer/cleaner). Ports for vectors/chunks/categories now use `string` IDs (not `crypto.UUID`) for consistency.

## 2026-02-18

- User registration verification: after create, status is `need_verification` (USER_STATUSES.NEED_VERIFICATION). A 6-digit code is generated, stored in Redis under key `verification_code:{email}` with TTL 30 min (VERIFICATION_CODE_TTL.SECONDS_30_MIN), and sent via Unosend. Tokens are not issued on register when status is need_verification.
- Email: `IEmailSender` port (`src/use-cases/interface/output/emailSender.interface.ts`), Unosend adapter (`src/adapters/implementations/output/emailSender/unosend.emailSender.ts`). Env: UNOSEND_API_KEY, UNOSEND_FROM_EMAIL. API: https://www.unosend.co/api/v1/emails (see docs.unosend.co).
- Verification code store: `IVerificationCodeStore` port (`src/use-cases/interface/output/verificationCodeStore.interface.ts`), Redis adapter (`src/adapters/implementations/output/verificationCodeStore/redis.verificationCodeStore.ts`). Env: REDIS_URL. Key prefix: verificationCode.enum VERIFICATION_CODE_KEY_PREFIX.EMAIL.
- Password hasher: `IPasswordHasher` port (`src/use-cases/interface/output/passwordHasher.interface.ts`), bcrypt adapter (`src/adapters/implementations/output/passwordHasher/bcrypt.passwordHasher.ts`). Config: BCRYPT_CONFIG.SALT_ROUNDS.
- User DI: `UserInject` in `src/adapters/inject/user.di.ts` wires password hasher (Bcrypt), email sender (Unosend), verification store (Redis), and `getUseCase(userRepo, tokenIssuer)` for UserUseCaseImpl.
- Enums: statuses.enum NEED_VERIFICATION; verificationCode.enum (KEY_PREFIX, TTL 30 min, LENGTH 6); verificationEmail.enum (SUBJECT); unosend.enum (BASE_URL, EMAILS_PATH). Helper: `src/helpers/verificationCode.ts` (generateVerificationCode).
- JWT token issuer: `JwtTokenIssuer` now stores bearer tokens in Redis with TTL derived from `TOKEN_EXPIRY.BEARER`, checks Redis presence on verify, and supports `revoke` to remove bearer tokens.

## 2026-03-23

- **DB repos fully implemented:** `DrizzleConversationRepo`, `DrizzleMessageRepo`, `DrizzleJarvisConfigRepo` all created in `src/adapters/implementations/output/sqlDB/repositories/`. `DrizzleSqlDB` facade exposes all four repos (users, conversations, messages, jarvisConfig).
- **`jarvis_config` table added** to Drizzle schema — singleton-row pattern; upsert via `onConflictDoUpdate`. Enum `JARVIS_CONFIG_ROW_ID` is the fixed primary key.
- **`CachedJarvisConfigRepo`** added (`src/adapters/implementations/output/jarvisConfig/cachedJarvisConfig.repo.ts`) — Redis decorator wrapping `DrizzleJarvisConfigRepo`. Cache key from `JARVIS_CONFIG_CACHE_KEY` enum. Cache is invalidated on `update()`.
- **`ILLMProvider` interface** added (`src/use-cases/interface/output/llmProvider.interface.ts`) — lighter alternative to `ILLMOrchestrator` with `textReply()` and `toolCall()` methods. `toolCall()` accepts a `Map<toolName, ZodSchema>` and returns validated params.
- **`OpenAILLMProvider`** implemented (`src/adapters/implementations/output/llmProvider/openai.llmProvider.ts`) — uses in-memory `Map<conversationId, ChatCompletionMessageParam[]>` for history. `textReply` reports context window usage percent. `toolCall` forces `tool_choice: "required"` and validates args against Zod schema via `z.toJSONSchema`.
- **`consoleCli.ts`** (`npm run chat`) — working interactive REPL. Calls `OpenAILLMProvider.textReply()` directly, loads system prompt from `CachedJarvisConfigRepo` (DB/Redis). Shows `[context: X%]` after each reply.
- **`jarvisCli.ts`** (`npm run jarvis`) — config CLI to view or set JARVIS system prompt. Supports multiline input (type `END` to finish). Invalidates Redis cache on update.
- **`AssistantUseCaseImpl`** updated to load system prompt from `IJarvisConfigDB` on every chat call (falls back to hardcoded default if not set). Returns `messageId` in `IChatResponse`.
- **`OpenAIOrchestrator`** is still a stub (`throw new Error("not yet implemented")`) — the HTTP API assistant path is not end-to-end functional yet.
- **Pinecone dep installed** (`@pinecone-database/pinecone`) — not yet integrated anywhere.

## Next Steps

- Implement `OpenAIOrchestrator.chat()` to make the HTTP API assistant path work end-to-end.
- Implement multi-turn tool loop in `AssistantUseCaseImpl` (currently single pass — tool results are persisted but the orchestrator is not re-run with them).
- Implement `WhisperSpeechToText.transcribe()`.
- Implement stub tools: `WebSearchTool`, `CalendarTool`, `ReminderTool`.
- Integrate Pinecone for memory/vector search.
