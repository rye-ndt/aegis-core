# Orchestrator Refactor — Implementation Plan

> Replaces the single-pass intent parser with a staged, schema-driven pipeline.
> Read `status.md` and `handler.ts` before starting.

---

## What changes

Current flow does everything in one LLM call: classify + tool pick + field extract + validate.

New flow is a staged state machine:

```
message → classify intent type → RAG + select tool → compile schema (loop) → token disambig → build request body
```

---

## Stage 0 — Shared types

### `src/helpers/enums/userIntentType.enum.ts` (new)

```typescript
export enum USER_INTENT_TYPE {
  SWAP = "swap",
  SEND_TOKEN = "send_token",
  CONTRACT_INTERACTION = "contract_interaction",
  RETRIEVE_BALANCE = "retrieve_balance",
  UNKNOWN = "unknown",
}
```

### Handler state (in `handler.ts`)

Replace `intentHistory: Map<number, string[]>` and `tokenDisambiguation: Map<number, DisambiguationPending>` with a single map:

```typescript
type OrchestratorStage = "compile" | "token_disambig";

interface OrchestratorSession {
  stage: OrchestratorStage;
  conversationId: string;
  messages: string[];                        // all user messages this intent
  manifest: ToolManifest;
  partialParams: Record<string, unknown>;    // accumulated schema fields (no tokenAddress/amountRaw yet)
  tokenSymbols: { from?: string; to?: string };
  disambiguation?: DisambiguationPending;    // only when stage == "token_disambig"
}

private orchestratorSessions = new Map<number, OrchestratorSession>();
```

---

## Stage 1 — Intent classifier

### Port: `src/use-cases/interface/output/intentClassifier.interface.ts` (new)

```typescript
import type { USER_INTENT_TYPE } from "../../../helpers/enums/userIntentType.enum";

export interface IIntentClassifier {
  classify(messages: string[]): Promise<USER_INTENT_TYPE>;
}
```

### Adapter: `src/adapters/implementations/output/intentParser/anthropic.intentClassifier.ts` (new)

- Uses `@anthropic-ai/sdk` with structured output (Zod schema)
- System prompt: "You are a classifier for a DeFi agent. Given these user messages, classify what the user wants. Return exactly one of: swap, send_token, contract_interaction, retrieve_balance, unknown."
- Output schema: `z.object({ intentType: z.nativeEnum(USER_INTENT_TYPE) })`
- One message in, one enum out. No tools, no history, just classification.

---

## Stage 2 — Tool selector

No new interface needed. Reuse `discoverRelevantTools(query)` in `IntentUseCaseImpl`, but change the query to concatenate `intentType + " " + lastUserMessage`.

Add to `IntentUseCaseImpl`:

```typescript
async selectTool(intentType: USER_INTENT_TYPE, messages: string[]): Promise<{ toolId: string; manifest: ToolManifest } | null>
```

Implementation:
1. `const query = intentType + " " + messages.join(" ")`
2. `const manifests = await this.discoverRelevantTools(query)` — existing method, unchanged
3. If `manifests.length === 0`: return null
4. If `manifests.length === 1`: return `{ toolId: manifests[0].toolId, manifest: manifests[0] }`
5. If multiple: one more LLM call — pass manifests (toolId + description + tags) + user messages → Claude returns the single best toolId. Use structured output: `z.object({ toolId: z.string() })`. Prompt: "Given these user messages and these available tools, which single tool best matches the user's intent? Return the toolId."
6. Return the selected manifest.

---

## Stage 3 — Schema compiler

### Port: `src/use-cases/interface/output/schemaCompiler.interface.ts` (new)

```typescript
import type { ToolManifest } from "./toolManifest.types";

export interface CompileResult {
  params: Record<string, unknown>;       // all extractable non-token fields
  missingQuestion: string | null;        // null = all required non-token fields are filled
  tokenSymbols: { from?: string; to?: string };
}

export interface ISchemaCompiler {
  compile(opts: {
    manifest: ToolManifest;
    messages: string[];
    autoFilled: Record<string, unknown>;    // system-known values: { scaAddress: "0x..." }
    partialParams: Record<string, unknown>; // carry from previous compile calls
  }): Promise<CompileResult>;
}
```

### Adapter: `src/adapters/implementations/output/intentParser/anthropic.schemaCompiler.ts` (new)

System prompt to Claude:
```
You are a field extractor for a DeFi transaction agent.

Tool schema (inputSchema):
<schema>

Auto-filled fields (do not ask user for these):
<autoFilled JSON>

Previously extracted fields:
<partialParams JSON>

Instructions:
- Scan the conversation and extract as many inputSchema fields as possible.
- Do NOT extract or ask for: tokenAddress, amountRaw (these are resolved later from token symbols).
- If the user mentions a token symbol (e.g. "USDC", "AVAX"), extract it as fromTokenSymbol or toTokenSymbol — NOT as tokenAddress.
- If any required field (from inputSchema.required) is still missing after extraction, set missingQuestion to a short, natural question to ask the user.
- If all required non-token fields are filled, set missingQuestion to null.
```

Output schema:
```typescript
z.object({
  params: z.record(z.unknown()),
  missingQuestion: z.string().nullable(),
  fromTokenSymbol: z.string().nullable(),
  toTokenSymbol: z.string().nullable(),
})
```

---

## Stage 4 — Use case additions

### `src/use-cases/interface/input/intent.interface.ts`

Add to `IIntentUseCase`:

```typescript
classifyIntent(messages: string[]): Promise<USER_INTENT_TYPE>;
selectTool(intentType: USER_INTENT_TYPE, messages: string[]): Promise<{ toolId: string; manifest: ToolManifest } | null>;
compileSchema(opts: {
  manifest: ToolManifest;
  messages: string[];
  userId: string;
  partialParams: Record<string, unknown>;
}): Promise<CompileResult>;
buildRequestBody(opts: {
  manifest: ToolManifest;
  params: Record<string, unknown>;
  resolvedFrom: ITokenRecord | null;
  resolvedTo: ITokenRecord | null;
  userId: string;
  amountHuman?: string;
}): Promise<{ to: string; data: string; value: string }>;
```

### `src/use-cases/implementations/intent.usecase.ts`

Add constructor params:
- `private readonly intentClassifier: IIntentClassifier`
- `private readonly schemaCompiler: ISchemaCompiler`

Implement `classifyIntent`: delegates to `this.intentClassifier.classify(messages)`.

Implement `compileSchema`:
1. Fetch `profile = await this.userProfileDB.findByUserId(userId)`
2. Build `autoFilled = { scaAddress: profile?.smartAccountAddress ?? "" }`
3. Merge with any pre-known values (userId, chainId)
4. Delegate to `this.schemaCompiler.compile({ manifest, messages, autoFilled, partialParams })`

Implement `buildRequestBody`:
1. Marshal token data into params: if `resolvedFrom`, set `params.tokenAddress = resolvedFrom.address`; if `amountHuman && resolvedFrom`, set `params.amountRaw = toRaw(amountHuman, resolvedFrom.decimals)` (move `toRaw` helper from `handler.ts` to a shared helper or inline here)
2. Build an `IntentPackage` from params: `{ action: manifest.toolId, params, confidence: 1, rawInput: "" }`
3. Call `await this.solverRegistry.getSolverAsync(manifest.toolId)` → solver
4. Throw if no solver
5. `calldata = await solver.buildCalldata(intentPackage, scaAddress)`
6. Verify `calldata.to` is non-empty, throw `Error("Incomplete calldata")` otherwise
7. Return calldata

---

## Stage 5 — Handler state machine rewrite

### `src/adapters/implementations/input/telegram/handler.ts`

Replace `intentHistory` and `tokenDisambiguation` maps with `orchestratorSessions: Map<number, OrchestratorSession>`.

Rewrite `bot.on("message:text", ...)`:

```
1. Auth check — same as before
2. replyWithChatAction("typing")
3. Ensure conversationId:
   - conversationId = this.conversations.get(chatId)
   - If none: create via assistantUseCase (or use a local UUID for now), store in this.conversations
4. Save message to conversation (existing `assistantUseCase.chat` or a new thin store call — see note below)

5. session = this.orchestratorSessions.get(chatId)

6. If session?.stage === "token_disambig":
   → handleDisambiguationReply(ctx, chatId, text, userId, session)
   → return

7. Push text into session?.messages or start new messages array

8. If no session (first message of this intent):
   a. intentType = await intentUseCase.classifyIntent([text])
   b. If intentType === RETRIEVE_BALANCE: handleFallbackChat(); clear; return
   c. If intentType === UNKNOWN: handleFallbackChat(); return
   d. toolResult = await intentUseCase.selectTool(intentType, [text])
   e. If no toolResult: handleFallbackChat(); return
   f. compileResult = await intentUseCase.compileSchema({ manifest: toolResult.manifest, messages: [text], userId, partialParams: {} })
   g. Create new OrchestratorSession { stage: "compile", conversationId, messages: [text], manifest: toolResult.manifest, partialParams: compileResult.params, tokenSymbols: compileResult.tokenSymbols }
   h. If compileResult.missingQuestion: reply(question); save session; return
   i. Else: goto step 10 (token resolution) with the new session

9. If session.stage === "compile":
   a. session.messages.push(text)
   b. compileResult = await intentUseCase.compileSchema({ manifest: session.manifest, messages: session.messages, userId, partialParams: session.partialParams })
   c. Merge compileResult.params into session.partialParams
   d. Merge compileResult.tokenSymbols into session.tokenSymbols
   e. If compileResult.missingQuestion: reply(question); update session; return
   f. Else: goto step 10 (token resolution)

10. Token resolution (same logic as existing startTokenResolution, adapted):
    a. chainId = parseInt(process.env.CHAIN_ID ?? "43113", 10)
    b. fromCandidates = tokenSymbols.from ? await intentUseCase.searchTokens(symbol, chainId) : []
    c. toCandidates = tokenSymbols.to ? await intentUseCase.searchTokens(symbol, chainId) : []
    d. If any candidates.length === 0 and symbol was specified: reply error; clear session; return
    e. resolvedFrom = candidates.length === 1 ? candidates[0] : null
    f. If any ambiguous:
       - Set session.stage = "token_disambig"
       - Set session.disambiguation = { ...existing shape, resolved*, candidates* }
       - reply(buildDisambiguationPrompt(...))
       - save session; return
    g. All resolved: goto step 11

11. Build and show request body:
    a. calldata = await intentUseCase.buildRequestBody({ manifest: session.manifest, params: session.partialParams, resolvedFrom, resolvedTo, userId, amountHuman: session.partialParams.amountHuman as string })
    b. Clear orchestratorSessions.get(chatId)
    c. reply(buildConfirmationMessage(session.manifest, calldata, resolvedFrom, resolvedTo, session.partialParams))
    d. The message should end with "Type /confirm to execute or /cancel to abort."
```

### `handleDisambiguationReply` changes

Receives `session: OrchestratorSession` instead of reading from `tokenDisambiguation` directly.

When disambiguation is complete (both tokens resolved): call `intentUseCase.buildRequestBody(...)`, show confirmation, clear session.

### `buildConfirmationMessage` (rename `buildEnrichedMessage`)

Takes `manifest`, `calldata`, `resolvedFrom`, `resolvedTo`, `params`. Shows:
- Action/tool name
- Token details (symbol, address, decimals)
- Amount (human readable + raw)
- Calldata (to, value, data hex)
- `params` JSON block
- `/confirm` prompt

---

## Stage 6 — DI wiring

### `src/adapters/inject/assistant.di.ts`

1. Instantiate `AnthropicIntentClassifier(apiKey)`
2. Instantiate `AnthropicSchemaCompiler(apiKey)`
3. Pass both to `IntentUseCaseImpl` constructor

---

## What stays unchanged

- `parseAndExecute()` and `confirmAndExecute()` in `IntentUseCaseImpl` — execution path is untouched
- `ManifestDrivenSolver`, `stepExecutors.ts`, `templateEngine.ts` — unchanged
- `tokenDisambiguation` logic shape — same, just moved into `OrchestratorSession.disambiguation`
- `handleFallbackChat` — unchanged
- All `/confirm`, `/cancel`, `/portfolio`, `/wallet` commands — unchanged
- Token search via `intentUseCase.searchTokens` — unchanged
- `buildDisambiguationPrompt` — unchanged

---

## Files to create

| File | Type |
|---|---|
| `src/helpers/enums/userIntentType.enum.ts` | New enum |
| `src/use-cases/interface/output/intentClassifier.interface.ts` | New port |
| `src/use-cases/interface/output/schemaCompiler.interface.ts` | New port |
| `src/adapters/implementations/output/intentParser/anthropic.intentClassifier.ts` | New adapter |
| `src/adapters/implementations/output/intentParser/anthropic.schemaCompiler.ts` | New adapter |

## Files to modify

| File | Change |
|---|---|
| `src/use-cases/interface/input/intent.interface.ts` | Add 4 new method signatures |
| `src/use-cases/implementations/intent.usecase.ts` | Add constructor params + implement new methods |
| `src/adapters/implementations/input/telegram/handler.ts` | Replace state maps + rewrite message:text handler |
| `src/adapters/inject/assistant.di.ts` | Wire new adapters into IntentUseCaseImpl |

---

## Notes for implementer

- `toRaw(amountHuman, decimals)` helper currently lives in `handler.ts`. Move it to `src/helpers/bigint.ts` (export from there) since `IntentUseCaseImpl.buildRequestBody` also needs it.
- The `AnthropicSchemaCompiler` must merge `partialParams` from the previous call — always pass the accumulated map so each LLM call builds on the last.
- When `compileResult.params` comes back, merge shallowly: `session.partialParams = { ...session.partialParams, ...compileResult.params }`.
- `selectTool` with multiple manifests: keep the LLM prompt minimal — just list `toolId: description` pairs, ask for the single best match. Use `max_tokens: 50`.
- The `intentType === RETRIEVE_BALANCE` case should still call `handleFallbackChat` which routes through the assistant (it has a `getPortfolio` tool registered).
- Do NOT call `parseFromHistory` or `validateIntent` in the new flow — those are part of the old path.
- `parseFromHistory` stays in `IIntentUseCase` for now (the HTTP path may still use it) — don't delete it.
