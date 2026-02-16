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

## Next Steps

- Implement the `store` use case fully.
- Fix remaining build errors in `Agent` related files.
