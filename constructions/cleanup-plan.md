# Backend Cleanup Plan

> Authored: 2026-04-23
> Scope: `be/src/` — prune dead code, unify duplicates, restore conventions, simplify branchy flows
> Baseline: 156 `.ts` files, ~10,345 LOC

Each step is independently executable and safely restartable. After each step run `npx tsc --noEmit` from `be/` to verify the compile. If a step fails, revert that step's edits and move on.

---

## Conventions recap (from `status.md` + `CLAUDE.md`)

- **IDs:** `newUuid()` (UUID v4). Never `Math.random()` / `crypto.randomUUID()`.
- **Timestamps:** `newCurrentUTCEpoch()` (seconds). Never inline `Math.floor(Date.now() / 1000)`.
- **Chain-specific values** live in `src/helpers/chainConfig.ts` only.
- **Hexagonal:** use-cases import only from `use-cases/interface/`. Assembly only in `adapters/inject/assistant.di.ts`.
- **No inline config literals:** hoist `process.env.X` reads into top-of-file consts.
- **Lazy singletons:** every DI getter caches via `this._x ??= …`.
- **Enums** in `src/helpers/enums/`.

---

## Phase 1 — Dead code (verified dead, high-ROI, low-risk)

### Step 1.1 — Delete unused use-case methods
Evidence: only declared in interface + implemented; no callers anywhere.

- Remove from `src/use-cases/interface/input/assistant.interface.ts`:
  - `listConversations`, `getConversation` (lines 29–33)
  - `IListConversationsInput`, `IGetConversationInput` types
- Remove from `src/use-cases/implementations/assistant.usecase.ts`:
  - `listConversations` (166–168), `getConversation` (170–172)
  - Drop `IGetConversationInput, IListConversationsInput, Conversation` imports that become unused
- Remove from `src/use-cases/interface/input/intent.interface.ts`:
  - `getHistory`, `parseFromHistory`, `previewCalldata` (lines 50–59)
  - `ParseFromHistoryResult` type (23–26)
- Remove from `src/use-cases/implementations/intent.usecase.ts`:
  - Methods at 373–407
  - Clean `ParseFromHistoryResult` import

### Step 1.2 — Delete unused repo methods + schema debt
All of the following have zero callers:

- `IMessageDB.findUncompressedByConversationId` (interface + drizzle impl)
- `IMessageDB.markCompressed` (interface + drizzle impl)
- `Message.compressedAtEpoch` is READ at `assistant.usecase.ts:66` (`!m.compressedAtEpoch`). Since no writer ever sets it, the filter is always true-ish: drop the field entirely from the interface + schema and simplify the filter to `.slice(-20)`.
- `IConversationDB.upsertSummary`, `.updateIntent`, `.flagForCompression` (interface + drizzle impl)
- `Conversation.summary`, `.intent` — never read. Remove from interface + schema. (`flaggedForCompression` never flipped from `false` in code; drop too.)
- `ITelegramSessionDB.deleteExpired` — no cleanup job runs it
- `ITokenDelegationDB.findByUserIdAndToken` — never called

DB columns (`messages.compressed_at_epoch`, `conversations.summary`, `conversations.intent`, `conversations.flagged_for_compression`) — remove from `schema.ts` and generate a drizzle migration:
```
npm run db:generate && npm run db:migrate
```

### Step 1.3 — Delete orphan files/dirs
- `src/adapters/implementations/output/solver/restful/traderJoe.solver.ts` — throws unconditionally, not registered in any solver registry, entire implementation body is commented out.
- `src/adapters/implementations/output/intentParser/openai.executionEstimator.ts` — never imported; DI uses `DeterministicExecutionEstimator`.
- `src/use-cases/interface/output/sse/` — empty directory (reserved scaffolding).

### Step 1.4 — Remove unused JWT plumbing
- `src/adapters/inject/assistant.di.ts:548` — drop `process.env.JWT_SECRET` from the HttpApiServer constructor call.
- `src/adapters/implementations/input/http/httpServer.ts:82` — drop the `_jwtSecret?: string` constructor parameter.
- No need to remove from `.env` docs; `JWT_SECRET` can stay as reserved. Update `status.md` env table row: drop it or mark deleted.

---

## Phase 2 — Convention restoration

### Step 2.1 — UUID convention
- `httpServer.ts:112`: replace `Math.random().toString(36).slice(2, 8)` with `newUuid().slice(0, 8)`. Import `newUuid` from `helpers/uuid`.

### Step 2.2 — Timestamp convention
Replace inline `Math.floor(Date.now() / 1000)` with `newCurrentUTCEpoch()`:
- `src/adapters/implementations/input/http/httpServer.ts:773`
- `src/adapters/implementations/output/cache/redis.signingRequest.ts:15`
- `src/adapters/implementations/output/delegation/delegationRequestBuilder.ts:21–22`
- `src/adapters/implementations/output/intentParser/deterministic.executionEstimator.ts:9`
- `src/use-cases/implementations/auth.usecase.ts:79`

Leave `Date.now()` as-is when it's millisecond latency measurement (e.g. `assistant.usecase.ts:195,207,221`).

### Step 2.3 — Hexagonal import violations
- `src/use-cases/implementations/intent.usecase.ts:27` imports `validateIntent` from `adapters/implementations/output/intentParser/intent.validator`.
  - Fix: expose `validateIntent` via a new `IIntentValidator` interface at `src/use-cases/interface/output/intentValidator.interface.ts`. Wire through `assistant.di.ts`. Pass into `IntentUseCaseImpl` as a constructor dep.
  - Simpler alternative: move the validation *logic* (pure function, no adapter deps) into `src/use-cases/interface/input/intent.errors.ts` alongside the error classes since the validator only throws `MissingFieldsError` / `InvalidFieldError`. Preferred: **move** the file to `src/use-cases/implementations/validateIntent.ts` — it has no adapter deps, just takes `IntentPackage`, message count, and manifest. Update imports.
- `src/use-cases/interface/output/cache/miniAppRequest.cache.ts:1` imports `MiniAppRequest` from `adapters/implementations/input/http/miniAppRequest.types`.
  - Fix: move the `MiniAppRequest` type into the interface folder (`src/use-cases/interface/output/cache/miniAppRequest.types.ts`). Have the http adapter import the type from there.

### Step 2.4 — Chain-specific map relocation
`src/adapters/implementations/output/walletData/privy.walletDataProvider.ts:8–16` hardcodes CAIP-2 chain IDs.
- Move `NETWORK_TO_CAIP2` into `src/helpers/chainConfig.ts` as `CAIP2_BY_NETWORK` (or add `caip2` property to each entry in `CHAIN_CONFIG` + helper).
- Re-import from chainConfig.

### Step 2.5 — DI singleton caching
`src/adapters/inject/assistant.di.ts` `getTelegramNotifier()` creates a new instance each call. Add `private _telegramNotifier: ITelegramNotifier | null = null;` and cache like the other getters.

### Step 2.6 — Centralize `process.env` reads
Hoist these to top-of-file constants:
- `OPENAI_MODEL` — in `openai.intentParser.ts`, `openai.schemaCompiler.ts`, `openai.intentClassifier.ts` (skip `openai.executionEstimator.ts`: deleted in 1.3)
- `MAX_TOOL_ROUNDS` — `assistant.usecase.ts`, `handler.ts`
- `MINI_APP_URL` — `handler.ts` (3 sites)
- `DELEGATION_TTL_SECONDS` — `delegationRequestBuilder.ts`
- `PANGOLIN_TOKEN_LIST_URL` — `pangolin.tokenCrawler.ts`

Pattern:
```ts
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";
```

---

## Phase 3 — Deduplicate (two or more solutions)

### Step 3.1 — OpenAI execution estimator (done by 1.3)
Remove the estimator file; keep only `DeterministicExecutionEstimator`.

### Step 3.2 — Telegram button-sender trio
`handler.ts:83–172` has three near-identical methods that build a MiniAppRequest, cache it, and send a reply with an InlineKeyboard webApp button. Replace with one helper:
```ts
private async sendMiniAppButton(
  ctx: CtxLike,
  request: MiniAppRequest,
  promptText: string,
  buttonText: string,
): Promise<void>
```
Call sites: welcome / sign / approve flows.

### Step 3.3 — ResolverEngine from/to token duplication
`resolverEngine.ts:41–115` — extract `resolveTokenField(symbol, chainId, label)` helper and call it for both `fromSymbol` and `toSymbol`.

### Step 3.4 — TraderJoe solver (done by 1.3)

### Step 3.5 — Error shape consistency (deferred)
Leave mixed throw vs typed errors for now; `httpServer.ts` already normalizes both paths to `{ error }`. Document in status.md as "known tech debt" but don't change.

---

## Phase 4 — Branchy-flow simplification

Only attempt these after Phases 1–3 compile cleanly.

### Step 4.1 — HTTP route dispatch (highest ROI)
`httpServer.ts:127–202` has 24+ `if (method === … && url.pathname === …)` branches.
Refactor to a dispatch map:
```ts
type Handler = (req, res, url, userId?) => Promise<void>;
const ROUTES: Array<{
  method: string;
  match: (pathname: string) => RouteMatch | null;
  requiresAuth: boolean;
  handler: Handler;
}> = [ … ];
```
Keep param-style routes (`/intent/:intentId`) using a tiny matcher (`/^\/intent\/([^/]+)$/`).

### Step 4.2 — Telegram disambiguation reply
`handler.ts:565–629` — flatten with early returns + a `slotConfig` lookup object (see agent finding #10).

### Step 4.3 — Telegram compile-loop state machine (optional, skip if risk too high)
`handler.ts:221–475` — stage machine. High blast-radius; leave unless time permits.

### Step 4.4 — ApproveMiniAppResponse dispatch
`httpServer.ts:542–606` — map subtype → handler function.

---

## Phase 5 — Documentation

### Step 5.1 — Update `status.md`
- Drop `JWT_SECRET` row from env table.
- Drop `sse/` from project-structure block.
- Drop `TraderJoeSolver` mention.
- Update Redis/DB sections if conversation columns removed.
- Add a "Cleanup 2026-04-23" note under Backlog explaining what was pruned and what conventions were enforced.

---

## Execution checklist

Per phase:
1. `npx tsc --noEmit` before starting.
2. Make changes, one concern at a time.
3. `npx tsc --noEmit` after each file group; fix failures before moving on.
4. Mark corresponding TaskList item completed.
5. Commit checkpoint (if git enabled) — **not auto**, user must approve.

If any step produces a TS compile cascade you can't resolve cleanly in <5 edits, **revert that step** and continue with the next. The plan is designed so phases don't block each other.

---

## Files touched by phase

| Phase | Key files |
| ----- | --------- |
| 1.1 | assistant.interface, assistant.usecase, intent.interface, intent.usecase |
| 1.2 | conversation.repo (iface+impl), message.repo (iface+impl), telegramSession.repo (iface+impl), tokenDelegation.repo (iface+impl), schema.ts, new drizzle migration |
| 1.3 | traderJoe.solver.ts, openai.executionEstimator.ts, rmdir sse |
| 1.4 | assistant.di.ts, httpServer.ts |
| 2.1 | httpServer.ts |
| 2.2 | httpServer, redis.signingRequest, delegationRequestBuilder, deterministic.executionEstimator, auth.usecase |
| 2.3 | intent.usecase, new validateIntent location, miniAppRequest.types move |
| 2.4 | privy.walletDataProvider, chainConfig |
| 2.5 | assistant.di |
| 2.6 | openai.*, handler, delegationRequestBuilder, pangolin.tokenCrawler, assistant.usecase |
| 3.2 | handler.ts |
| 3.3 | resolverEngine.ts |
| 4.1 | httpServer.ts |
| 4.2 | handler.ts |
| 4.4 | httpServer.ts |
| 5.1 | status.md |
