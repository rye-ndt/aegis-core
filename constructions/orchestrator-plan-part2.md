# Orchestrator Refactor — Part 2: Resolver Engine & Schema Compiler Extension

**Goal:** Build the `IResolverEngine` port and its concrete implementation.  
This service converts the raw human values emitted by the LLM (`resolverFields`) into the
machine-readable data required to fill `finalSchema`.  
It also extends `OpenAISchemaCompiler` to emit `resolverFields` when the tool uses a dual-schema manifest.

---

## 1. Overview

The Resolver Engine is an **output-port service** (lives in `use-cases/interface/output/`).
The concrete adapter lives in `adapters/implementations/output/resolver/`.

```
IResolverEngine  ←  ResolverEngineImpl (adapter)
                         ├── token resolver  → DB (ITokenRegistryService)
                         ├── amount resolver → BigInt conversion
                         └── handle resolver → GramjsTelegramResolver + IPrivyAuthService
```

**Resolver functions (per RESOLVER_FIELD enum):**

| Key | Input | Output | Side-effects |
|---|---|---|---|
| `fromTokenSymbol` | symbol string | `{ address, decimals, symbol }` | DB query; may trigger disambiguation |
| `toTokenSymbol` | same | same | DB query; may trigger disambiguation |
| `readableAmount` | human string ("5", "half", "all") | BigInt string in wei | Needs resolved `fromToken` decimals |
| `userHandle` | @handle string | EVM address string | MTProto + Privy |

**Disambiguation** is modelled as a thrown `DisambiguationRequiredError` (not a generic exception);
the handler catches it and enters `token_disambig` stage (Part 3).

---

## 2. Safety Checklist

- [ ] Part 1 is merged and `npm run typecheck` is clean.
- [ ] New files only — no modifications to existing resolver logic in the handler yet.
- [ ] The concrete `ResolverEngineImpl` is NOT wired to the DI container yet (that happens in Part 4).
- [ ] `DisambiguationRequiredError` must NOT extend `Error.prototype` in a way that breaks `instanceof`
  checks across module boundaries — use the standard `extends Error` pattern.

---

## 3. Files to create / modify

### 3.1 `src/use-cases/interface/output/resolver.interface.ts` — **[NEW]**

```typescript
// src/use-cases/interface/output/resolver.interface.ts

import type { ITokenRecord } from "./repository/tokenRegistry.repo";

/** Thrown when a token query returns >1 candidate; handler enters disambiguation sub-loop. */
export class DisambiguationRequiredError extends Error {
  constructor(
    public readonly slot: "from" | "to",
    public readonly symbol: string,
    public readonly candidates: ITokenRecord[],
  ) {
    super(`Disambiguation required for ${slot} token "${symbol}" — ${candidates.length} candidates`);
    this.name = "DisambiguationRequiredError";
  }
}

/** The fully resolved payload after all resolver functions have run. */
export interface ResolvedPayload {
  /** Resolved from-token (address, decimals, symbol). Null if not present in requiredFields. */
  fromToken:         ITokenRecord | null;
  /** Resolved to-token. */
  toToken:           ITokenRecord | null;
  /** Raw amount in wei as a bigint-backed string ("1000000"). Null if not applicable. */
  rawAmount:         string | null;
  /** EVM wallet address of the recipient resolved from userHandle. Null if not present. */
  recipientAddress:  string | null;
  /** Telegram user ID of the recipient (stored for post-confirm notification). Null if N/A. */
  recipientTelegramUserId: string | null;
  /** Current user's SCA / EOA address, injected from session. */
  senderAddress:     string | null;
}

export interface IResolverEngine {
  /**
   * Run all resolver functions for the given set of human-provided field values.
   *
   * @param resolverFields   - The raw human values extracted by the LLM (from CompileResult.resolverFields).
   * @param userId           - Internal userId; used to fetch senderAddress from the user profile.
   * @param chainId          - Chain to search tokens on.
   *
   * @throws DisambiguationRequiredError when a token symbol matches multiple candidates.
   */
  resolve(params: {
    resolverFields:  Partial<Record<string, string>>;
    userId:          string;
    chainId:         number;
  }): Promise<ResolvedPayload>;

  /**
   * Resolve a single token symbol to a token record.
   * Used by the handleDisambiguationReply handler path (Part 3) to confirm a specific candidate.
   */
  resolveTokenByAddress(
    address: string,
    chainId: number,
  ): Promise<ITokenRecord | null>;
}
```

---

### 3.2 `src/adapters/implementations/output/resolver/resolverEngine.ts` — **[NEW]**

```typescript
// src/adapters/implementations/output/resolver/resolverEngine.ts

import type { IResolverEngine, ResolvedPayload } from "../../../../use-cases/interface/output/resolver.interface";
import { DisambiguationRequiredError } from "../../../../use-cases/interface/output/resolver.interface";
import type { ITokenRegistryService } from "../../../../use-cases/interface/output/tokenRegistry.interface";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { ITelegramHandleResolver } from "../../../../use-cases/interface/output/telegramResolver.interface";
import { TelegramHandleNotFoundError } from "../../../../use-cases/interface/output/telegramResolver.interface";
import type { IPrivyAuthService } from "../../../../use-cases/interface/output/privyAuth.interface";
import type { ITokenRecord } from "../../../../use-cases/interface/output/repository/tokenRegistry.repo";
import { RESOLVER_FIELD } from "../../../../helpers/enums/resolverField.enum";
import { toRaw } from "../../../../helpers/bigint";

export class ResolverEngineImpl implements IResolverEngine {
  constructor(
    private readonly tokenRegistry:        ITokenRegistryService,
    private readonly userProfileDB:        IUserProfileDB,
    private readonly telegramResolver?:    ITelegramHandleResolver,
    private readonly privyAuthService?:    IPrivyAuthService,
  ) {}

  async resolve(params: {
    resolverFields:  Partial<Record<string, string>>;
    userId:          string;
    chainId:         number;
  }): Promise<ResolvedPayload> {
    const { resolverFields, userId, chainId } = params;

    // ── Sender address (always injected from session) ────────────────────────
    const profile = await this.userProfileDB.findByUserId(userId);
    const senderAddress = profile?.eoaAddress ?? null;

    // ── Token resolution ─────────────────────────────────────────────────────
    let fromToken: ITokenRecord | null = null;
    let toToken:   ITokenRecord | null = null;

    const fromSymbol = resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL];
    const toSymbol   = resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL];

    if (fromSymbol) {
      const candidates = await this.tokenRegistry.searchBySymbol(fromSymbol, chainId);
      if (candidates.length === 0) throw new Error(`Token not found: ${fromSymbol}`);
      if (candidates.length > 1)  throw new DisambiguationRequiredError("from", fromSymbol, candidates);
      fromToken = candidates[0]!;
    }

    if (toSymbol) {
      const candidates = await this.tokenRegistry.searchBySymbol(toSymbol, chainId);
      if (candidates.length === 0) throw new Error(`Token not found: ${toSymbol}`);
      if (candidates.length > 1)  throw new DisambiguationRequiredError("to", toSymbol, candidates);
      toToken = candidates[0]!;
    }

    // ── Amount resolution (requires fromToken decimals) ──────────────────────
    let rawAmount: string | null = null;
    const humanAmount = resolverFields[RESOLVER_FIELD.READABLE_AMOUNT];
    if (humanAmount && fromToken) {
      rawAmount = String(toRaw(humanAmount, fromToken.decimals));
    }

    // ── User handle → EVM wallet ─────────────────────────────────────────────
    let recipientAddress:          string | null = null;
    let recipientTelegramUserId:   string | null = null;

    const handle = resolverFields[RESOLVER_FIELD.USER_HANDLE];
    if (handle) {
      if (!this.telegramResolver || !this.privyAuthService) {
        throw new Error("P2P transfers are not configured on this server.");
      }

      let telegramUserId: string;
      try {
        telegramUserId = await this.telegramResolver.resolveHandle(handle);
      } catch (err) {
        if (err instanceof TelegramHandleNotFoundError) {
          throw new Error(`Could not find Telegram user @${handle}. Check the handle and try again.`);
        }
        throw err;
      }

      recipientAddress        = await this.privyAuthService.getOrCreateWalletByTelegramId(telegramUserId);
      recipientTelegramUserId = telegramUserId;
    }

    return {
      fromToken,
      toToken,
      rawAmount,
      recipientAddress,
      recipientTelegramUserId,
      senderAddress,
    };
  }

  async resolveTokenByAddress(address: string, chainId: number): Promise<ITokenRecord | null> {
    // Used by the disambiguation confirm path — look up by exact address.
    const records = await this.tokenRegistry.searchBySymbol(address, chainId);
    return records.find((r) => r.address.toLowerCase() === address.toLowerCase()) ?? null;
  }
}
```

**Guard:** `toRaw` already exists in `helpers/bigint.ts`. Verify signature before use:
check `export function toRaw(human: string, decimals: number): bigint` or similar.
If the return type is `bigint`, convert with `String(bigint)` as shown.

---

### 3.3 Extend `OpenAISchemaCompiler` — **[MODIFY]**

**File:** `src/adapters/implementations/output/intentParser/openai.schemaCompiler.ts`

Add `resolverFields` output to an existing `CompileResult`. When the tool manifest has a
`requiredFields` object, the LLM should extract values keyed by `RESOLVER_FIELD` enum values,
and those raw values get emitted as `resolverFields`.

**Strategy:** Add a second structured output field `resolverFieldsJson` (similar to `paramsJson`)
and populate it only when `manifest.requiredFields` is non-empty.

**Diff (conceptual):**

```diff
 const CompileSchema = z.object({
   paramsJson:      z.string(),
   missingQuestion: z.string().nullable(),
   fromTokenSymbol: z.string().nullable(),
   toTokenSymbol:   z.string().nullable(),
   telegramHandle:  z.string().nullable(),
+  resolverFieldsJson: z.string().nullable(),  // JSON-encoded Record<RESOLVER_FIELD, string>
 });
```

In `buildSystemPrompt`, when `manifest.requiredFields` exists, add an extra instruction block:

```typescript
if (manifest.requiredFields && Object.keys(manifest.requiredFields).length > 0) {
  prompt += `\n\nThis tool uses the dual-schema extraction model.
Extract values for these resolver fields from the conversation:
${JSON.stringify(manifest.requiredFields, null, 2)}

Emit them as a JSON-encoded string in resolverFieldsJson. Keys must exactly match the
requiredFields property names (e.g. "fromTokenSymbol", "readableAmount").
Only include fields that the user has explicitly provided. Use null if none were found.`;
}
```

In the `compile()` return value:

```diff
   return {
     params,
     missingQuestion: parsed.missingQuestion,
     tokenSymbols,
     telegramHandle: parsed.telegramHandle ?? undefined,
+    resolverFields: parsed.resolverFieldsJson
+      ? (JSON.parse(parsed.resolverFieldsJson) as Partial<Record<string, string>>)
+      : undefined,
   };
```

**Guard:** If `resolverFieldsJson` is null or malformed, return `undefined` (not throw) — fall through
to the legacy `tokenSymbols` path. This keeps the existing disambiguation flow working for any tool
that does NOT yet define `requiredFields`.

---

### 3.4 `src/use-cases/interface/output/resolver.interface.ts` — export from index (optional)

The `DisambiguationRequiredError` should be re-exported from the intent interface so that the handler
can import it from one place:

**File:** `src/use-cases/interface/input/intent.interface.ts`

```diff
 export { MissingFieldsError, InvalidFieldError, ConversationLimitError } from './intent.errors';
+export { DisambiguationRequiredError } from '../output/resolver.interface';
+export type { ResolvedPayload } from '../output/resolver.interface';
```

---

## 4. Turn-limit guard

The proposal specifies a **10-turn max** on the disambiguation sub-loop. Add a `disambigTurns`
counter to `OrchestratorSession` (defined in Part 3) and enforce it:

```typescript
// enforcement inside handleDisambiguationReply (Part 3):
if ((session.disambigTurns ?? 0) >= 10) {
  this.orchestratorSessions.delete(chatId);
  await ctx.reply("Token selection timed out. Please repeat your request.");
  return;
}
session.disambigTurns = (session.disambigTurns ?? 0) + 1;
```

The same counter pattern applies to the compile loop (already guarded by max 10 messages
in the existing code — verify against `MAX_TOOL_ROUNDS` env var, currently 10).

---

## 5. Verification

```bash
cd /Users/rye/Downloads/aegis/be
npm run typecheck   # must pass
```

**Integration smoke test (manual):**
1. Set a breakpoint (or add a `console.log`) inside `ResolverEngineImpl.resolve`.
2. Send a swap message that uses a known single-match symbol (e.g. USDC).
3. Verify the resolver returns `fromToken` correctly.
4. Repeat with a symbol that has 2+ DB entries — verify `DisambiguationRequiredError` is thrown.

Do NOT wire the engine to the DI container or the handler yet. That is Part 4.

---

## 6. What Part 3 builds on top of this

Part 3 refactors `handler.ts`:
- Adds the `/buy`, `/sell`, `/convert`, etc. command intercepts using `parseIntentCommand()`.
- Replaces the local `tokenSymbols`-based disambiguation with `DisambiguationRequiredError` catches.
- Extends `OrchestratorSession` with `resolverFields`, `disambigTurns`, and `resolved` payload.
- Implements the full Phase 1→4 pipeline inside the handler without yet injecting `ResolverEngineImpl`.
