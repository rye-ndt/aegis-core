# Token Enrichment Plan

## Goal

After the OpenAI intent parser extracts `fromTokenSymbol` / `toTokenSymbol` from user intent, look them up in `token_registry` via a case-insensitive pattern search. If a symbol matches more than one token, ask the Telegram user to pick one before proceeding. Once every token slot is resolved to exactly one DB record, compute `amountRaw` from `amountHuman + decimals`, marshal everything into an enriched message, and send it to the Telegram user. **Stop there — no execution, no simulation.**

---

## What does NOT change

- `IntentPackage` interface — do not touch
- `OpenAIIntentParser` — do not touch
- `intent.usecase.ts` — do not touch
- Any execution / simulation / solver code
- The `AnthropicIntentParser` — ignored entirely

---

## Files to change

```
src/use-cases/interface/output/repository/tokenRegistry.repo.ts     ← add searchBySymbol
src/adapters/implementations/output/sqlDB/repositories/tokenRegistry.repo.ts ← implement it
src/use-cases/interface/output/tokenRegistry.interface.ts            ← add searchBySymbol
src/adapters/implementations/output/tokenRegistry/db.tokenRegistry.ts ← implement it
src/adapters/implementations/input/telegram/handler.ts               ← main logic
```

---

## Step 1 — Add `searchBySymbol` to `ITokenRegistryDB`

**File:** `src/use-cases/interface/output/repository/tokenRegistry.repo.ts`

Add one method to the `ITokenRegistryDB` interface:

```typescript
searchBySymbol(pattern: string, chainId: number): Promise<ITokenRecord[]>;
```

The full interface becomes:

```typescript
export interface ITokenRegistryDB {
  upsert(token: TokenRecordInit): Promise<void>;
  findBySymbolAndChain(symbol: string, chainId: number): Promise<ITokenRecord | undefined>;
  searchBySymbol(pattern: string, chainId: number): Promise<ITokenRecord[]>;
  listByChain(chainId: number): Promise<ITokenRecord[]>;
}
```

---

## Step 2 — Implement `searchBySymbol` in `DrizzleTokenRegistryRepo`

**File:** `src/adapters/implementations/output/sqlDB/repositories/tokenRegistry.repo.ts`

Import `ilike` from `drizzle-orm` (already imports `and`, `eq` — add `ilike` to the same import).

Add after `findBySymbolAndChain`:

```typescript
async searchBySymbol(pattern: string, chainId: number): Promise<ITokenRecord[]> {
  const rows = await this.db
    .select()
    .from(tokenRegistry)
    .where(and(ilike(tokenRegistry.symbol, `%${pattern}%`), eq(tokenRegistry.chainId, chainId)));
  return rows.map((r) => this.toRecord(r));
}
```

- `ilike` is case-insensitive LIKE in Postgres.
- Pattern is wrapped with `%` on both sides so `usdc` matches `USDC`, `aUSDC`, etc.
- The caller passes the raw symbol from the intent (e.g. `"USDC"` or `"avax"`).

---

## Step 3 — Add `searchBySymbol` to `ITokenRegistryService`

**File:** `src/use-cases/interface/output/tokenRegistry.interface.ts`

Add one method:

```typescript
searchBySymbol(pattern: string, chainId: number): Promise<ITokenRecord[]>;
```

Full interface:

```typescript
import type { ITokenRecord } from "./repository/tokenRegistry.repo";

export interface ITokenRegistryService {
  resolve(symbol: string, chainId: number): Promise<{ address: string; decimals: number } | undefined>;
  searchBySymbol(pattern: string, chainId: number): Promise<ITokenRecord[]>;
  listByChain(chainId: number): Promise<ITokenRecord[]>;
}
```

---

## Step 4 — Implement `searchBySymbol` in `DbTokenRegistryService`

**File:** `src/adapters/implementations/output/tokenRegistry/db.tokenRegistry.ts`

Add after `resolve`:

```typescript
async searchBySymbol(pattern: string, chainId: number): Promise<ITokenRecord[]> {
  return this.tokenRegistryDB.searchBySymbol(pattern.toUpperCase(), chainId);
}
```

Call `toUpperCase()` on pattern for consistency with how symbols are stored (uppercased by the crawler).

---

## Step 5 — Telegram handler changes

**File:** `src/adapters/implementations/input/telegram/handler.ts`

### 5a — Add disambiguation state type (top of file, before the class)

```typescript
interface DisambiguationPending {
  intent: IntentPackage;                // the parsed intent
  resolvedFrom: ITokenRecord | null;    // null = not yet resolved
  resolvedTo: ITokenRecord | null;      // null = not yet resolved
  awaitingSlot: "from" | "to";          // which slot is currently awaiting user input
  fromCandidates: ITokenRecord[];       // candidates for fromToken (may be empty if not needed)
  toCandidates: ITokenRecord[];         // candidates for toToken (may be empty if not needed)
}
```

Import `ITokenRecord` from `../../../../use-cases/interface/output/repository/tokenRegistry.repo` and `IntentPackage` from `../../../../use-cases/interface/output/intentParser.interface`.

### 5b — Add state field to the class

```typescript
private tokenDisambiguation = new Map<number, DisambiguationPending>();
```

Place it alongside the existing `conversations`, `sessionCache`, `intentHistory` maps.

### 5c — Rewrite the `message:text` handler

Replace the entire `bot.on("message:text", ...)` handler body with the following logic (pseudocode first, exact implementation follows):

```
1. ensureAuthenticated — if not, reply and return
2. replyWithChatAction("typing")
3. chatId = ctx.chat.id
4. text = ctx.message.text.trim()

5. IF tokenDisambiguation.has(chatId):
     call handleDisambiguationReply(ctx, chatId, text, session.userId)
     return

6. Push text to intentHistory (same as current code)
7. Parse intent via intentParser.parse(history, session.userId)
   - On ConversationLimitError: clear history, reply error, return
   - On MissingFieldsError / InvalidFieldError: reply prompt, return
8. If intent === null: clear history, reply "No onchain intent detected.", return

9. Clear history (successful parse)

10. call startTokenResolution(ctx, chatId, intent)
```

### 5d — Private method: `startTokenResolution`

```typescript
private async startTokenResolution(
  ctx: ContextType,
  chatId: number,
  intent: IntentPackage,
): Promise<void>
```

Logic:

```
1. fromCandidates = []
2. toCandidates = []

3. If intent.fromTokenSymbol exists:
     fromCandidates = await tokenRegistryService.searchBySymbol(intent.fromTokenSymbol, chainId)
     If fromCandidates.length === 0:
       reply("Token not found: {fromTokenSymbol}. Make sure the token is supported on this chain.")
       return

4. If intent.toTokenSymbol exists:
     toCandidates = await tokenRegistryService.searchBySymbol(intent.toTokenSymbol, chainId)
     If toCandidates.length === 0:
       reply("Token not found: {toTokenSymbol}. Make sure the token is supported on this chain.")
       return

5. resolvedFrom = fromCandidates.length === 1 ? fromCandidates[0] : null
6. resolvedTo   = toCandidates.length === 1   ? toCandidates[0]   : null

7. If fromCandidates.length > 1:
     pending = {
       intent,
       resolvedFrom: null,
       resolvedTo: null,
       awaitingSlot: "from",
       fromCandidates,
       toCandidates,
     }
     tokenDisambiguation.set(chatId, pending)
     reply(buildDisambiguationPrompt("from", intent.fromTokenSymbol!, fromCandidates))
     return

8. If toCandidates.length > 1:
     pending = {
       intent,
       resolvedFrom,       // already set (single match or null if no fromToken)
       resolvedTo: null,
       awaitingSlot: "to",
       fromCandidates,
       toCandidates,
     }
     tokenDisambiguation.set(chatId, pending)
     reply(buildDisambiguationPrompt("to", intent.toTokenSymbol!, toCandidates))
     return

9. // All tokens resolved without disambiguation
   reply(buildEnrichedMessage(intent, resolvedFrom, resolvedTo))
```

### 5e — Private method: `handleDisambiguationReply`

```typescript
private async handleDisambiguationReply(
  ctx: ContextType,
  chatId: number,
  text: string,
  _userId: string,
): Promise<void>
```

Logic:

```
1. pending = tokenDisambiguation.get(chatId)!
2. index = parseInt(text, 10)

3. If isNaN(index) OR index < 1 OR index > candidates.length:
     // User sent something that's not a valid selection
     // Treat it as a new intent attempt — clear disambiguation and re-parse
     tokenDisambiguation.delete(chatId)
     reply("Disambiguation cancelled. Please repeat your request.")
     return

4. selected = candidates[index - 1]   // candidates = pending.fromCandidates or pending.toCandidates depending on awaitingSlot

5. If pending.awaitingSlot === "from":
     pending.resolvedFrom = selected
     // Now check if toToken also needs disambiguation
     If pending.toCandidates.length > 1:
       pending.awaitingSlot = "to"
       tokenDisambiguation.set(chatId, pending)
       reply(buildDisambiguationPrompt("to", pending.intent.toTokenSymbol!, pending.toCandidates))
       return
     Else:
       pending.resolvedTo = pending.toCandidates[0] ?? null

6. If pending.awaitingSlot === "to":
     pending.resolvedTo = selected

7. tokenDisambiguation.delete(chatId)
8. reply(buildEnrichedMessage(pending.intent, pending.resolvedFrom, pending.resolvedTo))
```

### 5f — Private method: `buildDisambiguationPrompt`

```typescript
private buildDisambiguationPrompt(
  slot: "from" | "to",
  symbol: string,
  candidates: ITokenRecord[],
): string
```

Output format:

```
Multiple tokens found for "USDC". Which one do you mean?

1. USDC — USD Coin — 0xB97...B4a (6 decimals)
2. aUSDC — Aave USDC — 0xfcD...12b (6 decimals)

Reply with the number.
```

Implementation notes:
- Address is truncated: `addr.slice(0, 6) + "..." + addr.slice(-4)`
- `slot` label is "source token" or "destination token"
- No Markdown code blocks — keep it plain so it renders cleanly

### 5g — Private method: `buildEnrichedMessage`

```typescript
private buildEnrichedMessage(
  intent: IntentPackage,
  fromToken: ITokenRecord | null,
  toToken: ITokenRecord | null,
): string
```

Output format (Markdown):

```
Intent confirmed

Action: Swap
From: USDC (USD Coin)
  Address: `0xB97EF9...`
  Decimals: 6
  Amount: 100 USDC (100000000 raw)
To: AVAX (Avalanche)
  Address: `0x000000...`
  Decimals: 18
Slippage: 0.5%
```

Implementation notes:

**`amountRaw` computation** (exact, no float precision loss):

```typescript
function toRaw(amountHuman: string, decimals: number): string {
  const [intPart, fracPart = ""] = amountHuman.split(".");
  const padded = fracPart.padEnd(decimals, "0").slice(0, decimals);
  const raw = BigInt(intPart) * BigInt(10 ** decimals) + BigInt(padded || "0");
  return raw.toString();
}
```

- Split on `.`, pad fractional to `decimals` places, trim excess, join and parse as BigInt.
- No floating-point arithmetic — safe for 18-decimal tokens.

Include `amountRaw` only for `fromToken` (the amount being spent). `toToken` has no amount.

If a slot (`fromToken` or `toToken`) is `null` (the intent didn't include that token), skip that line.

---

## Step 6 — Constructor dependency check

`TelegramAssistantHandler` already receives `tokenRegistryService?: ITokenRegistryService`. After Step 3/4, this service now has `searchBySymbol`. No new constructor parameter is needed.

The handler must guard: `if (!this.tokenRegistryService || !this.chainId)` before calling `searchBySymbol`, same pattern as the existing `fetchPortfolio` guard.

---

## Step 7 — `/cancel` command update

In the `/cancel` handler, also clear `tokenDisambiguation`:

```typescript
this.tokenDisambiguation.delete(ctx.chat.id);
```

Add this line alongside the existing cancel logic.

---

## Invariants / guardrails

| Rule | Rationale |
|------|-----------|
| Never call `intentUseCase.parseAndExecute()` in this flow | This plan stops at enrichment |
| Never call `solver`, `simulator`, `userOpBuilder` | Out of scope |
| `searchBySymbol` uses ILIKE — not exact match | Allows partial symbol like `usdc` to match `USDC` |
| `amountRaw` computed with BigInt string arithmetic, not `parseFloat * 10**n` | Prevents float overflow on 18-decimal tokens |
| Disambiguation state is deleted on: successful resolution, non-numeric reply, `/cancel` | Prevents stale state |
| If a symbol has 0 DB results, reply and return immediately — do not continue | Token must exist in DB |
| Only `fromToken` gets `amountRaw` (it has `amountHuman`). `toToken` only shows address + decimals | `toToken` amount is unknown pre-execution |
| `toUpperCase()` is applied to pattern in `DbTokenRegistryService.searchBySymbol` | Symbols are stored uppercase by the crawler |

---

## Sequence diagram

```
User: "swap 100 usdc for avax"
  → parse intent → { fromTokenSymbol: "USDC", toTokenSymbol: "AVAX", amountHuman: "100" }
  → searchBySymbol("USDC", 43113) → [USDC record, aUSDC record]   (2 results)
  → send disambiguation: "Multiple tokens for USDC. Reply 1 or 2."

User: "1"
  → handleDisambiguationReply → resolvedFrom = USDC record
  → searchBySymbol already done: toCandidates = [AVAX record]     (1 result, no ambiguity)
  → resolvedTo = AVAX record
  → buildEnrichedMessage → send enriched summary to Telegram
  → DONE (stop)

User: "swap 100 avax for joe"
  → searchBySymbol("AVAX", 43113) → [AVAX]    (1 result)
  → searchBySymbol("JOE", 43113)  → [JOE, JOE.e, xJOE]  (3 results)
  → send disambiguation: "Multiple tokens for JOE. Reply 1, 2, or 3."

User: "1"
  → resolvedTo = JOE record
  → buildEnrichedMessage → send to Telegram
  → DONE
```

---

## What the implementing agent must NOT do

- Do not run database migrations — no schema changes needed
- Do not add new files — all changes go into existing files listed above
- Do not modify `IntentPackage`, `OpenAIIntentParser`, or any use-case except `tokenRegistry`
- Do not add `console.log` beyond what already exists in the file
- Do not add JSDoc or comments unless the logic is non-obvious (e.g., the `toRaw` bigint trick warrants a one-liner comment)
