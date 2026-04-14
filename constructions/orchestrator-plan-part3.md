# Orchestrator Refactor — Part 3: Handler Refactor (Phases 1–4 Pipeline)

**Goal:** Refactor `handler.ts` to implement the full 4-phase deterministic pipeline described in  
`orchestrator-proposal.md`, using the infrastructure built in Parts 1 & 2.  
This is the largest and most impactful change. All edits are inside a single file.

---

## 1. Overview of the new message flow

```
Incoming text message
  │
  ▼
Phase 1 — ROUTING
  ├─ parseIntentCommand(text) → INTENT_COMMAND or null
  ├─ If null → fallback to general LLM chat (unchanged)
  └─ If found → fetch tool manifest from DB by command → open OrchestratorSession
  │
  ▼
Phase 2 — LLM EXTRACTION LOOP (max 10 turns)
  ├─ compileSchema() against requiredFields (or inputSchema for legacy tools)
  ├─ If missingQuestion → ask user → wait → loop
  ├─ If turn count ≥ 10 → abort + reset
  └─ If all required extracted → proceed to Phase 3
  │
  ▼
Phase 3 — DATA RESOLUTION LOOP (max 10 turns per disambiguation)
  ├─ resolverEngine.resolve(resolverFields) → ResolvedPayload | DisambiguationRequiredError
  ├─ If DisambiguationRequiredError → show numbered list → enter token_disambig stage
  │     ├─ On user reply → pick candidate → re-enter resolve() with patched resolverFields
  │     └─ After 10 tries → abort + reset
  └─ If success → proceed to Phase 4
  │
  ▼
Phase 4 — FINALIZATION
  ├─ Populate finalSchema using resolved payload
  ├─ buildRequestBody() to produce calldata
  ├─ Show confirmation message to user (finalSchema JSON + calldata summary)
  └─ tryCreateDelegationRequest() (unchanged)
```

---

## 2. Safety Checklist

- [ ] Parts 1 and 2 are complete; `npm run typecheck` is clean.
- [ ] Make a git commit before touching `handler.ts` — this is the riskiest file.
- [ ] All existing commands (`/start`, `/auth`, `/logout`, `/new`, `/history`, `/confirm`,
  `/cancel`, `/portfolio`, `/wallet`, `/sign`) must remain functionally identical.
- [ ] Legacy tool flow (tools without `requiredFields`) must still work through the `tokenSymbols` path.
- [ ] The handler must **not** import `ResolverEngineImpl` directly — only `IResolverEngine` interface.

---

## 3. Updated types inside `handler.ts`

### 3.1 Extend `OrchestratorSession`

```typescript
type OrchestratorStage = "compile" | "token_disambig";

interface DisambiguationPending {
  resolvedFrom:    ITokenRecord | null;
  resolvedTo:      ITokenRecord | null;
  awaitingSlot:    "from" | "to";
  fromCandidates:  ITokenRecord[];
  toCandidates:    ITokenRecord[];
}

interface OrchestratorSession {
  stage:           OrchestratorStage;
  conversationId:  string;
  messages:        string[];      // conversation history for LLM extraction
  manifest:        ToolManifest;
  partialParams:   Record<string, unknown>;
  tokenSymbols:    { from?: string; to?: string };  // legacy path
  // ── New dual-schema fields ─────────────────────────────────────────────────
  resolverFields:  Partial<Record<string, string>>; // human values from LLM
  disambigTurns:   number;        // counts disambiguation reply attempts
  compileTurns:    number;        // counts LLM extraction loop turns
  resolved?:       import("../../../../../use-cases/interface/output/resolver.interface").ResolvedPayload;
  // ──────────────────────────────────────────────────────────────────────────
  disambiguation?: DisambiguationPending;
  recipientTelegramUserId?: string;
}
```

**Note:** `resolverFields` defaults to `{}` for legacy tools. The compile loop merges new
`resolverFields` on each turn, same as `partialParams`.

---

### 3.2 Constructor: add `IResolverEngine` as optional dependency

```typescript
constructor(
  private readonly assistantUseCase:       IAssistantUseCase,
  private readonly authUseCase:            IAuthUseCase,
  private readonly telegramSessions:       ITelegramSessionDB,
  private readonly botToken?:              string,
  private readonly intentUseCase?:         IIntentUseCase,
  private readonly portfolioUseCase?:      IPortfolioUseCase,
  private readonly chainId:                number = parseInt(process.env.CHAIN_ID ?? "43113", 10),
  private readonly userProfileRepo?:       IUserProfileDB,
  private readonly pendingDelegationRepo?: IPendingDelegationDB,
  private readonly delegationBuilder?:     IDelegationRequestBuilder,
  private readonly telegramHandleResolver?:ITelegramHandleResolver,
  private readonly privyAuthService?:      IPrivyAuthService,
  private readonly signingRequestUseCase?: ISigningRequestUseCase,
  private readonly resolverEngine?:        IResolverEngine,   // ← NEW (optional, last)
) {}
```

Adding as the **last optional** parameter preserves all existing construction call sites.

---

### 3.3 New import additions

```typescript
import type { IResolverEngine } from "../../../../use-cases/interface/output/resolver.interface";
import { DisambiguationRequiredError } from "../../../../use-cases/interface/output/resolver.interface";
import { parseIntentCommand, INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
```

---

## 4. Routing — Phase 1

Replace the current `bot.on("message:text", ...)` handler with this new routing logic:

```typescript
bot.on("message:text", async (ctx) => {
  const session = await this.ensureAuthenticated(ctx.chat.id);
  if (!session) {
    await ctx.reply("Please authenticate first. Use /auth <token>.");
    return;
  }

  await ctx.replyWithChatAction("typing");

  const chatId = ctx.chat.id;
  const text   = ctx.message.text.trim();
  const userId = session.userId;

  console.log(`[Handler] message chatId=${chatId} userId=${userId} text="${text}"`);

  try {
    const existing = this.orchestratorSessions.get(chatId);

    // ── Disambiguation reply ────────────────────────────────────────────────
    if (existing?.stage === "token_disambig") {
      await this.handleDisambiguationReply(ctx, chatId, text, userId, existing);
      return;
    }

    // ── Phase 1: Routing ────────────────────────────────────────────────────
    const command = parseIntentCommand(text);

    if (!existing) {
      if (command) {
        // Command-driven path (new deterministic pipeline)
        await this.startCommandSession(ctx, chatId, userId, command, text);
      } else {
        // Legacy: classify → select tool → compile (unchanged)
        await this.startLegacySession(ctx, chatId, userId, text);
      }
      return;
    }

    // ── Continuing compilation loop ─────────────────────────────────────────
    if (existing.stage === "compile") {
      existing.messages.push(text);
      await this.continueCompileLoop(ctx, chatId, userId, existing);
    }
  } catch (err) {
    console.error("[Handler] error handling message:", err);
    await ctx.reply("Sorry, something went wrong. Please try again.");
  }
});
```

---

## 5. `startCommandSession` — Phase 1 (new commands)

```typescript
private async startCommandSession(
  ctx:    { reply: (text: string, opts?: object) => Promise<unknown> },
  chatId: number,
  userId: string,
  command: INTENT_COMMAND,
  text:   string,
): Promise<void> {
  if (!this.intentUseCase) {
    await ctx.reply("Intent service not configured.");
    return;
  }

  // Map command → tool manifest via DB (selectTool already queries by keyword / category)
  // We pass the command as the query so the vector search / ILIKE finds the right tool.
  const toolResult = await this.intentUseCase.selectTool(
    command as unknown as import("../../../../helpers/enums/userIntentType.enum").USER_INTENT_TYPE,
    [text],
  );

  if (!toolResult) {
    await ctx.reply(`No tool is registered for ${command}. Contact the admin.`);
    return;
  }

  const compileResult = await this.intentUseCase.compileSchema({
    manifest:       toolResult.manifest,
    messages:       [text],
    userId,
    partialParams:  {},
  });

  const newSession: OrchestratorSession = {
    stage:          "compile",
    conversationId: this.conversations.get(chatId) ?? "",
    messages:       [text],
    manifest:       toolResult.manifest,
    partialParams:  compileResult.params,
    tokenSymbols:   compileResult.tokenSymbols,
    resolverFields: compileResult.resolverFields ?? {},
    disambigTurns:  0,
    compileTurns:   1,
  };

  // Handle telegram handle extracted on the first message (legacy path)
  if (compileResult.telegramHandle && !newSession.recipientTelegramUserId) {
    const resolved = await this.resolveRecipientHandle(
      ctx, chatId, compileResult.telegramHandle, newSession,
    );
    if (!resolved) return;
  }

  if (compileResult.missingQuestion) {
    this.orchestratorSessions.set(chatId, newSession);
    await ctx.reply(compileResult.missingQuestion);
    return;
  }

  await this.finishCompileOrResolve(ctx, chatId, userId, newSession);
}
```

**Note:** `selectTool` currently accepts `USER_INTENT_TYPE` as first arg, but internally just builds
a query string. Passing `INTENT_COMMAND` (which is a string like `/buy`) works because the method
does `\`${intentType} ${messages.join(" ")}\`` and then queries by keyword. Verify this assumption
by checking `IntentUseCaseImpl.selectTool` — if it breaks, add a method overload or a new
`selectToolByCommand(command: string, messages: string[])` to the interface.

---

## 6. `startLegacySession` — Phase 1 (free-form text, existing flow)

Extract the existing "no session" branch into a named method to keep the handler readable.
This is a pure extraction refactor — no logic changes.

```typescript
private async startLegacySession(
  ctx:    { reply: (text: string, opts?: object) => Promise<unknown> },
  chatId: number,
  userId: string,
  text:   string,
): Promise<void> {
  if (!this.intentUseCase) {
    await ctx.reply("Intent service not configured.");
    return;
  }

  const intentType = await this.intentUseCase.classifyIntent([text]);

  if (
    intentType === USER_INTENT_TYPE.RETRIEVE_BALANCE ||
    intentType === USER_INTENT_TYPE.UNKNOWN
  ) {
    await this.handleFallbackChat(ctx, chatId, text, userId);
    return;
  }

  const toolResult = await this.intentUseCase.selectTool(intentType, [text]);
  if (!toolResult) {
    await this.handleFallbackChat(ctx, chatId, text, userId);
    return;
  }

  const compileResult = await this.intentUseCase.compileSchema({
    manifest:      toolResult.manifest,
    messages:      [text],
    userId,
    partialParams: {},
  });

  const newSession: OrchestratorSession = {
    stage:          "compile",
    conversationId: this.conversations.get(chatId) ?? "",
    messages:       [text],
    manifest:       toolResult.manifest,
    partialParams:  compileResult.params,
    tokenSymbols:   compileResult.tokenSymbols,
    resolverFields: compileResult.resolverFields ?? {},
    disambigTurns:  0,
    compileTurns:   1,
  };

  if (compileResult.telegramHandle && !newSession.recipientTelegramUserId) {
    const resolved = await this.resolveRecipientHandle(ctx, chatId, compileResult.telegramHandle, newSession);
    if (!resolved) return;
  }

  if (compileResult.missingQuestion) {
    this.orchestratorSessions.set(chatId, newSession);
    await ctx.reply(compileResult.missingQuestion);
    return;
  }

  await this.finishCompileOrResolve(ctx, chatId, userId, newSession);
}
```

---

## 7. `continueCompileLoop` — Phase 2 (multi-turn extraction)

```typescript
private async continueCompileLoop(
  ctx:     { reply: (text: string, opts?: object) => Promise<unknown> },
  chatId:  number,
  userId:  string,
  session: OrchestratorSession,
): Promise<void> {
  const MAX_COMPILE_TURNS = parseInt(process.env.MAX_TOOL_ROUNDS ?? "10", 10);

  if (session.compileTurns >= MAX_COMPILE_TURNS) {
    this.orchestratorSessions.delete(chatId);
    await ctx.reply(
      "I couldn't collect all required information after several attempts. Please start over.",
    );
    return;
  }

  session.compileTurns += 1;

  const compileResult = await this.intentUseCase!.compileSchema({
    manifest:      session.manifest,
    messages:      session.messages,
    userId,
    partialParams: session.partialParams,
  });

  session.partialParams  = { ...session.partialParams, ...compileResult.params };
  session.tokenSymbols   = { ...session.tokenSymbols,  ...compileResult.tokenSymbols };
  session.resolverFields = { ...session.resolverFields, ...(compileResult.resolverFields ?? {}) };

  if (compileResult.telegramHandle && !session.recipientTelegramUserId) {
    const resolved = await this.resolveRecipientHandle(ctx, chatId, compileResult.telegramHandle, session);
    if (!resolved) return;
  }

  if (compileResult.missingQuestion) {
    this.orchestratorSessions.set(chatId, session);
    await ctx.reply(compileResult.missingQuestion);
    return;
  }

  await this.finishCompileOrResolve(ctx, chatId, userId, session);
}
```

---

## 8. `finishCompileOrResolve` — transition from Phase 2 to Phase 3

This replaces the existing `finishCompileOrAsk` method for dual-schema tools, and falls back to
`resolveTokensAndFinish` for legacy tools.

```typescript
private async finishCompileOrResolve(
  ctx:     { reply: (text: string, opts?: object) => Promise<unknown> },
  chatId:  number,
  userId:  string,
  session: OrchestratorSession,
): Promise<void> {
  const missing = this.getMissingRequiredFields(session.manifest, session.partialParams);
  if (missing.length > 0) {
    const question = await this.intentUseCase!.generateMissingParamQuestion(session.manifest, missing);
    this.orchestratorSessions.set(chatId, session);
    await ctx.reply(question);
    return;
  }

  // ── Dual-schema path (Phase 3) ────────────────────────────────────────────
  const usesDualSchema =
    session.manifest.requiredFields &&
    Object.keys(session.manifest.requiredFields).length > 0 &&
    this.resolverEngine;

  if (usesDualSchema) {
    await this.runResolutionPhase(ctx, chatId, userId, session);
    return;
  }

  // ── Legacy path (Phase 3 fallback) ────────────────────────────────────────
  await this.resolveTokensAndFinish(ctx, chatId, userId, session);
}
```

---

## 9. `runResolutionPhase` — Phase 3 (resolver engine)

```typescript
private async runResolutionPhase(
  ctx:     { reply: (text: string, opts?: object) => Promise<unknown> },
  chatId:  number,
  userId:  string,
  session: OrchestratorSession,
): Promise<void> {
  try {
    const resolved = await this.resolverEngine!.resolve({
      resolverFields: session.resolverFields,
      userId,
      chainId:        this.chainId,
    });
    session.resolved = resolved;

    if (resolved.recipientTelegramUserId) {
      session.recipientTelegramUserId = resolved.recipientTelegramUserId;
    }

    await this.buildAndShowConfirmationFromResolved(ctx, chatId, userId, session);
  } catch (err) {
    if (err instanceof DisambiguationRequiredError) {
      await this.enterDisambiguationFromResolver(ctx, chatId, session, err);
      return;
    }
    this.orchestratorSessions.delete(chatId);
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Could not resolve transaction details: ${msg}`);
  }
}
```

---

## 10. `enterDisambiguationFromResolver` — Phase 3 disambiguation

```typescript
private async enterDisambiguationFromResolver(
  ctx:     { reply: (text: string, opts?: object) => Promise<unknown> },
  chatId:  number,
  session: OrchestratorSession,
  err:     DisambiguationRequiredError,
): Promise<void> {
  session.stage = "token_disambig";
  session.disambiguation = {
    resolvedFrom:   err.slot === "to"   ? (session.resolved?.fromToken ?? null) : null,
    resolvedTo:     err.slot === "from" ? (session.resolved?.toToken   ?? null) : null,
    awaitingSlot:   err.slot,
    fromCandidates: err.slot === "from" ? err.candidates : [],
    toCandidates:   err.slot === "to"   ? err.candidates : [],
  };
  this.orchestratorSessions.set(chatId, session);
  await ctx.reply(this.buildDisambiguationPrompt(err.slot, err.symbol, err.candidates));
}
```

---

## 11. `handleDisambiguationReply` — updated to patch `resolverFields` and re-run resolver

The existing disambiguation reply handler remains mostly intact, but after selecting a token it
must patch `session.resolverFields` with the confirmed address and re-run `runResolutionPhase`
(dual-schema path) or call `buildAndShowConfirmation` (legacy path).

Key change in `handleDisambiguationReply` after selecting a candidate:

```typescript
// After selecting the token cancel the disambig state:
session.disambigTurns = (session.disambigTurns ?? 0) + 1;

if (session.disambigTurns >= 10) {
  this.orchestratorSessions.delete(chatId);
  await ctx.reply("Token selection timed out. Please start over.");
  return;
}

if (pending.awaitingSlot === "from") {
  // Patch the human resolverField with the unambiguous address so the resolver picks it up cleanly
  session.resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] = selected.address; // use address to force exact match
  pending.resolvedFrom = selected;
  if (pending.toCandidates.length > 1) { /* ... show to disambig ... */ }
  pending.resolvedTo = pending.toCandidates[0] ?? null;
} else {
  session.resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL] = selected.address;
  pending.resolvedTo = selected;
}

// Re-enter resolution with the patched resolverFields
session.disambiguation = undefined;
session.stage          = "compile"; // so we don't loop back into disambig handling

const usesDualSchema = session.manifest.requiredFields && this.resolverEngine;
if (usesDualSchema) {
  await this.runResolutionPhase(ctx, chatId, userId, session);
} else {
  await this.buildAndShowConfirmation(ctx, chatId, userId, session, pending.resolvedFrom, pending.resolvedTo);
}
```

---

## 12. Phase 4 — `buildAndShowConfirmationFromResolved`

New method that uses the `ResolvedPayload` instead of raw `ITokenRecord | null` arguments.

```typescript
private async buildAndShowConfirmationFromResolved(
  ctx:     { reply: (text: string, opts?: object) => Promise<unknown> },
  chatId:  number,
  userId:  string,
  session: OrchestratorSession,
): Promise<void> {
  const { resolved } = session;
  if (!resolved) {
    await ctx.reply("Internal error: resolution payload missing.");
    return;
  }

  // Merge resolved values back into partialParams for buildRequestBody
  if (resolved.rawAmount)         session.partialParams.amountRaw   = resolved.rawAmount;
  if (resolved.recipientAddress)  session.partialParams.recipient   = resolved.recipientAddress;
  if (resolved.senderAddress)     session.partialParams.userAddress = resolved.senderAddress;

  let calldata: { to: string; data: string; value: string };
  try {
    calldata = await this.intentUseCase!.buildRequestBody({
      manifest:     session.manifest,
      params:       session.partialParams,
      resolvedFrom: resolved.fromToken,
      resolvedTo:   resolved.toToken,
      userId,
      amountHuman:  session.partialParams.amountHuman as string | undefined,
    });
  } catch (err) {
    console.error("[Handler] buildRequestBody failed:", err);
    this.orchestratorSessions.delete(chatId);
    await ctx.reply(`Could not build transaction: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // ── Phase 4: show finalSchema + calldata to user ─────────────────────────
  if (session.manifest.finalSchema) {
    // Populate finalSchema fields from the resolved payload for display
    const finalSchemaFilled = this.populateFinalSchema(session.manifest.finalSchema, resolved, session.partialParams);
    await ctx.reply(this.buildFinalSchemaConfirmation(session, finalSchemaFilled, calldata));
  } else {
    // Legacy confirmation format
    await this.safeSend(ctx, this.buildConfirmationMessage(session, calldata, resolved.fromToken, resolved.toToken));
  }

  if (session.recipientTelegramUserId) {
    this.pendingRecipientNotifications.set(userId, { telegramUserId: session.recipientTelegramUserId });
  }
  this.orchestratorSessions.delete(chatId);
  await this.tryCreateDelegationRequest(ctx, userId, session, resolved.fromToken);
}
```

---

### 12.1 `populateFinalSchema` — merge resolved values into the schema definition

```typescript
private populateFinalSchema(
  finalSchema: Record<string, unknown>,
  resolved:    ResolvedPayload,
  params:      Record<string, unknown>,
): Record<string, unknown> {
  const filled: Record<string, unknown> = {};
  const properties = (finalSchema.properties ?? {}) as Record<string, { description?: string }>;

  for (const key of Object.keys(properties)) {
    if (key === "from_token_address" && resolved.fromToken)  filled[key] = resolved.fromToken.address;
    else if (key === "to_token_address" && resolved.toToken) filled[key] = resolved.toToken.address;
    else if (key === "raw_amount"      && resolved.rawAmount) filled[key] = resolved.rawAmount;
    else if (key === "recipient_address" && resolved.recipientAddress) filled[key] = resolved.recipientAddress;
    else if (key === "sender_address"  && resolved.senderAddress) filled[key] = resolved.senderAddress;
    else if (params[key] !== undefined) filled[key] = params[key];
  }

  return filled;
}
```

---

### 12.2 `buildFinalSchemaConfirmation` — Phase 4 confirmation message

```typescript
private buildFinalSchemaConfirmation(
  session:      OrchestratorSession,
  finalSchema:  Record<string, unknown>,
  calldata:     { to: string; data: string; value: string },
): string {
  const lines = [
    "*Transaction Preview*",
    "",
    `Action: ${session.manifest.name}`,
    `Protocol: ${session.manifest.protocolName}`,
    "",
    "**Resolved Parameters:**",
    "```json",
    JSON.stringify(finalSchema, null, 2),
    "```",
    "",
    "*Calldata*",
    `To: \`${calldata.to}\``,
    `Value: ${calldata.value}`,
    `\`\`\`\n${calldata.data}\n\`\`\``,
    "",
    "Type /confirm to execute or /cancel to abort.",
  ];
  return lines.join("\n");
}
```

---

## 13. Verification

```bash
cd /Users/rye/Downloads/aegis/be
npm run typecheck   # must pass 0 errors
```

**Manual regression tests (run in local Telegram bot):**

| Scenario | Expected |
|---|---|
| Send free-form "swap 5 USDC for AVAX" | Old flow works unchanged |
| Send `/buy AVAX with 5 USDC` | New command routing; LLM extract; resolve; confirm |
| Send `/sell` alone | Bot asks for details (missing question) |
| Send ambiguous token (e.g. token with 2+ DB entries) | Numbered list shown, user selects, flow continues |
| Send non-number to disambiguation | Session cleared, "start over" message |
| 11 compile turns | Abort with "start over" message |
| `/cancel` mid-session | Session cleared, "intent cancelled" |
| `/confirm` after confirmation shown | Existing `confirmLatestIntent` path unchanged |

---

## 14. What Part 4 builds on top of this

Part 4 wires `ResolverEngineImpl` into `AssistantInject` DI container and passes it to
`TelegramAssistantHandler`, adds the `IResolverEngine` port to the `IIntentUseCase` boundary
(or keeps it injected directly — decision to be confirmed), and covers:
- DB migration verification
- `context.md` update
- Final `npm run typecheck && npm run build` gate check
- Production environment variable notes
