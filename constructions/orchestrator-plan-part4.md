# Orchestrator Refactor — Part 4: DI Wiring, Migration, & Final Verification

**Goal:** Wire `ResolverEngineImpl` into the DI container, pass it to `TelegramAssistantHandler`,
run the database migration for the two new `tool_manifests` columns, and deliver a full end-to-end
verification checklist. This part also updates `context.md`.

---

## 1. Overview

At this point:
- The data model (`requiredFields`, `finalSchema`) exists on the manifest type (Part 1).
- The resolver engine is implemented (Part 2).
- The handler implements the 4-phase pipeline (Part 3).

Part 4 is pure wiring. It is low-risk but must be done carefully because `AssistantInject` is the
single source of truth for the object graph, and `TelegramAssistantHandler` is constructed in
`telegramCli.ts`.

---

## 2. Safety Checklist

- [ ] Parts 1, 2, 3 are merged; `npm run typecheck` is clean.
- [ ] The database migration has NOT been applied yet to production — apply it ONLY after the
  migration script has been verified locally.
- [ ] No existing constructor call sites break (all new params are optional, appended last).
- [ ] `context.md` must be updated as the final step.

---

## 3. DI Container — `src/adapters/inject/assistant.di.ts`

### 3.1 Import the new implementation

```typescript
// Add to the imports section at the top of assistant.di.ts
import { ResolverEngineImpl } from "../implementations/output/resolver/resolverEngine";
import type { IResolverEngine } from "../../use-cases/interface/output/resolver.interface";
```

### 3.2 Add a private singleton field

```typescript
// Inside AssistantInject class body, alongside the other private fields:
private _resolverEngine: IResolverEngine | null = null;
```

### 3.3 Add the factory method

```typescript
getResolverEngine(): IResolverEngine {
  if (!this._resolverEngine) {
    this._resolverEngine = new ResolverEngineImpl(
      this.getTokenRegistryService(),       // ITokenRegistryService
      this.getSqlDB().userProfiles,         // IUserProfileDB
      this.getTelegramHandleResolver(),     // ITelegramHandleResolver (optional)
      this.getPrivyAuthService(),           // IPrivyAuthService (optional)
    );
  }
  return this._resolverEngine;
}
```

**Guard:** `getTelegramHandleResolver()` returns `undefined` when env vars are missing.
`ResolverEngineImpl` accepts both optional deps and will throw a descriptive error at runtime only
if a P2P transfer is attempted without the resolver configured — this matches existing behaviour.

---

## 4. Entry point — `src/telegramCli.ts`

Open `telegramCli.ts` and locate where `TelegramAssistantHandler` is constructed.
Pass `di.getResolverEngine()` as the last argument (it is optional, so existing call sites
with fewer arguments are unaffected).

**Before:**
```typescript
const handler = new TelegramAssistantHandler(
  di.getUseCase(),
  di.getAuthUseCase(),
  db.telegramSessions,
  process.env.TELEGRAM_BOT_TOKEN,
  di.getIntentUseCase(),
  di.getPortfolioUseCase(),
  chainId,
  db.userProfiles,
  db.pendingDelegations,
  di.getDelegationRequestBuilder(),
  di.getTelegramHandleResolver(),
  di.getPrivyAuthService(),
  di.getSigningRequestUseCase(onSignResolved),
);
```

**After:**
```typescript
const handler = new TelegramAssistantHandler(
  di.getUseCase(),
  di.getAuthUseCase(),
  db.telegramSessions,
  process.env.TELEGRAM_BOT_TOKEN,
  di.getIntentUseCase(),
  di.getPortfolioUseCase(),
  chainId,
  db.userProfiles,
  db.pendingDelegations,
  di.getDelegationRequestBuilder(),
  di.getTelegramHandleResolver(),
  di.getPrivyAuthService(),
  di.getSigningRequestUseCase(onSignResolved),
  di.getResolverEngine(),             // ← NEW
);
```

**Guard:** If `telegramCli.ts` does not construct the handler itself but delegates to
`AssistantInject`, locate that method and apply the same change there. Run `grep -r "TelegramAssistantHandler" src/`
to find all construction sites before editing.

---

## 5. Database migration

### 5.1 Verify the schema change (Part 1 completed this)

The two columns should already be in `schema.ts`:

```typescript
  requiredFields:    text("required_fields"),
  finalSchema:       text("final_schema"),
```

### 5.2 Run migration locally

```bash
cd /Users/rye/Downloads/aegis/be
npm run db:generate
# Review the generated migration SQL file — confirm it only adds two nullable columns
npm run db:migrate
```

**Expected migration SQL (verify generated file matches):**
```sql
ALTER TABLE "tool_manifests" ADD COLUMN "required_fields" text;
ALTER TABLE "tool_manifests" ADD COLUMN "final_schema" text;
```

No `NOT NULL` constraint, no default value, no data backfill — this is safe to apply to a live DB
with zero downtime.

### 5.3 Verify in PostgreSQL

```bash
psql $DATABASE_URL -c "\d tool_manifests"
```

Confirm `required_fields` and `final_schema` columns are present and typed `text`.

---

## 6. Tool manifest registration for new commands

For the new slash commands (`/buy`, `/sell`, `/convert`, `/dca`, `/topup`) to work end-to-end,
each command needs at least one tool manifest registered in the DB with:

- A `requiredFields` JSON Schema that uses the `RESOLVER_FIELD` enum keys.
- A `finalSchema` JSON Schema that defines the machine-readable fields.
- Tags that include the command keyword so `selectTool` can find it.

### Example manifest payload for `/buy` (use `POST /tools` to register):

```json
{
  "toolId": "traderJoe-buy",
  "category": "defi",
  "name": "Buy Token",
  "description": "Buy a target token using your default base token (USDC) via Trader Joe",
  "protocolName": "Trader Joe",
  "tags": ["buy", "swap", "dex"],
  "priority": 10,
  "isDefault": true,
  "inputSchema": {
    "type": "object",
    "properties": {
      "amountHuman": { "type": "string", "description": "Amount to spend in human units" },
      "toTokenSymbol": { "type": "string", "description": "Symbol of the token to buy" }
    },
    "required": ["amountHuman", "toTokenSymbol"]
  },
  "requiredFields": {
    "type": "object",
    "properties": {
      "fromTokenSymbol": { "type": "string", "description": "Token to spend (default: USDC)" },
      "toTokenSymbol":   { "type": "string", "description": "Token you want to buy" },
      "readableAmount":  { "type": "string", "description": "How much to spend" }
    },
    "required": ["toTokenSymbol", "readableAmount"]
  },
  "finalSchema": {
    "type": "object",
    "properties": {
      "from_token_address": { "type": "string" },
      "to_token_address":   { "type": "string" },
      "raw_amount":         { "type": "string" },
      "sender_address":     { "type": "string" }
    }
  },
  "steps": [
    {
      "kind": "http_get",
      "name": "quote",
      "url": "https://api.traderjoexyz.com/v1/quote?...",
      "extract": { "calldata": "$.tx.data" }
    }
  ],
  "chainIds": [43113]
}
```

**Note:** The `requiredFields→fromTokenSymbol` is not marked required (defaults to USDC).
The resolver engine will still run it if provided; if absent, the resolver simply skips it
and defaults to the configured base token.

---

## 7. `context.md` update

Create or update `/Users/rye/Downloads/aegis/be/context.md` with the following entry:

```markdown
## [2026-04-14] Orchestrator Refactor — Dual-Schema Deterministic Pipeline

### Summary
Implemented deterministic intent routing & dual-schema extraction as described in
`constructions/orchestrator-proposal.md`. Replaced the ad-hoc LLM classify→compile flow with a
4-phase pipeline driven by slash commands.

### Files Modified
- `src/helpers/enums/intentCommand.enum.ts`          — [NEW] INTENT_COMMAND + parseIntentCommand()
- `src/helpers/enums/resolverField.enum.ts`           — [NEW] RESOLVER_FIELD enum
- `src/use-cases/interface/output/toolManifest.types.ts` — added requiredFields, finalSchema
- `src/use-cases/interface/output/repository/toolManifest.repo.ts` — extended IToolManifestRecord
- `src/use-cases/interface/output/schemaCompiler.interface.ts` — added resolverFields to CompileResult
- `src/use-cases/interface/output/resolver.interface.ts` — [NEW] IResolverEngine port + errors
- `src/adapters/implementations/output/resolver/resolverEngine.ts` — [NEW] ResolverEngineImpl
- `src/adapters/implementations/output/intentParser/openai.schemaCompiler.ts` — emits resolverFields
- `src/adapters/implementations/input/telegram/handler.ts` — 4-phase pipeline refactor
- `src/adapters/implementations/output/sqlDB/schema.ts` — 2 new nullable columns
- `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repository.ts` — mapper
- `src/adapters/inject/assistant.di.ts`               — getResolverEngine() + wiring
- `src/telegramCli.ts`                                — pass resolverEngine to handler

### Commands Executed
- npm run typecheck   ✅
- npm run db:generate ✅
- npm run db:migrate  ✅
- npm run build       ✅

### Tests Run
- TypeScript compile gate: passed
- Manual Telegram regression: all existing commands verified

### Known Limitations / Next Steps
- selectTool() currently maps INTENT_COMMAND values via keyword search.
  A dedicated selectToolByCommand(command, messages) method would be cleaner.
- /topup and /dca require external integrations not yet implemented.
- readableAmount resolver does not yet handle "half" or "all" — only numeric strings.
```

---

## 8. Final verification sequence

Run in order; **stop and fix before continuing if any step fails**:

```bash
cd /Users/rye/Downloads/aegis/be

# 1. Type check
npm run typecheck

# 2. Build
npm run build

# 3. DB migration
npm run db:generate
npm run db:migrate

# 4. Start bot locally
npm run dev
# or: node dist/telegramCli.js

# 5. Manual smoke tests (send from a real Telegram client):
#    - /start                → welcome message
#    - /auth <token>         → authenticated
#    - swap 5 USDC for AVAX → legacy flow; confirm shown
#    - /buy AVAX with 5 USDC → new pipeline; resolver runs; confirm shown
#    - /wallet               → wallet info unchanged
#    - /portfolio            → portfolio unchanged
#    - /cancel               → session cleared
```

---

## 9. Rollback plan

If any step fails irreversibly:

1. `git revert` all commits from this feature branch.
2. `npm run db:migrate` will revert if using Drizzle snapshot-based migrations
   (check if the migration supports `DOWN` — if not, run the inverse SQL manually):
   ```sql
   ALTER TABLE "tool_manifests" DROP COLUMN IF EXISTS "required_fields";
   ALTER TABLE "tool_manifests" DROP COLUMN IF EXISTS "final_schema";
   ```
3. Restart the bot. Existing manifests are unaffected (columns were nullable).

---

## 10. Open design questions (ask before implementing if unclear)

> [!IMPORTANT]
> **Q1:** Should `selectTool` in `IIntentUseCase` be extended with a `selectToolByCommand(command: INTENT_COMMAND, messages: string[])` overload, or is casting `INTENT_COMMAND` to `USER_INTENT_TYPE` acceptable as a temporary measure?

> [!IMPORTANT]
> **Q2:** For `/buy` with no explicit from-token, should the resolver default to USDC (hardcoded), or should the manifest declare a `defaultFromToken` field?

> [!NOTE]
> **Q3:** The `readableAmount` resolver currently only handles numeric strings. Should "half" and "all" be handled by fetching the user's live balance before conversion? If yes, the resolver engine needs an `IUserBalanceService` dependency — that is a separate spike.
