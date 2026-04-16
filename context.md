# context.md

## 2026-04-15T19:37 — Stablecoin / Fiat Auto-detection

### Task summary
Added deterministic stablecoin intent detection so non-crypto users can write
`"send @alice $5"`, `"send @bob 5 dollars"`, `"send @charlie 5 bucks"`, etc.
without being asked which token they mean. USDC is automatically injected as
the source token when fiat language is detected and the LLM did not extract a
from-token symbol.

### Files modified
- `be/src/adapters/implementations/input/telegram/handler.ts`
  - Added module-level `detectStablecoinIntent(text)` pure function (regex-based,
    no LLM cost). Matches: `$N`, `N dollars`, `N bucks`, `N usd`, `N usdc`.
  - Injected USDC auto-detection block after every `compileSchema` call:
    - `startCommandSession` (command-driven path)
    - `startLegacySession` (free-form text path)
    - `continueCompileLoop` (multi-turn continuation — checks full message
      history so detection is sticky across turns)
  - Injection is guarded: only fires when the LLM did not already extract a
    `fromTokenSymbol`, preventing override of explicit tokens like AVAX or ETH.
  - Both `resolverFields[FROM_TOKEN_SYMBOL]` and `tokenSymbols.from` are set to
    ensure both the dual-schema path and the legacy token-resolution path benefit.

### Commands executed
- `node ./node_modules/.bin/tsc --noEmit` → EXIT:0 (zero type errors)

### Tests run
None automated. Manual scenario coverage defined in implementation_plan.md.

### Known risks / assumptions
- USDC must exist in the token registry for the configured chainId. If it is
  missing, the resolver engine will throw `Token not found: USDC` (same error
  as any other missing token — no regression).
- If multiple USDC contract records exist for the chain, the disambiguation
  prompt will fire (correct behaviour — same as any ambiguous symbol).
- Detection is intentionally conservative: requires a numeric value adjacent to
  the fiat keyword so bare words like "send some dollars" are not matched.

---

## 2026-04-16T08:21 — Telegram Login Support (POST /auth/privy chatId linking)

### Task summary
Extended `POST /auth/privy` to accept an optional `telegramChatId` field.
When the Mini App authenticates via Privy and passes the user's Telegram chatId,
the backend now links the session in `telegram_sessions` in a single call —
eliminating the need for the manual `/auth <token>` step in the bot.

### Files modified
- `src/use-cases/interface/input/auth.interface.ts`
  — Added `telegramChatId?: string` to `IPrivyLoginInput`. Method signature unchanged.
- `src/use-cases/implementations/auth.usecase.ts`
  — Imported `ITelegramSessionDB`; added it as optional 5th constructor arg.
  — In `loginWithPrivy`: after `issueJwt`, upserts the telegram session if `telegramChatId` was provided.
- `src/adapters/implementations/input/http/httpServer.ts`
  — Extended Zod schema for `/auth/privy` to include `telegramChatId: z.string().regex(/^\d+$/).optional()`.
  — Passes `telegramChatId` through to `loginWithPrivy`.
- `src/adapters/inject/assistant.di.ts`
  — Passes `db.telegramSessions` as 5th arg to `AuthUseCaseImpl`.
- `src/adapters/implementations/input/telegram/handler.ts`
  — Added backward-compat comment to `bot.on("message:web_app_data", ...)` handler.

### Commands executed
- `/opt/homebrew/bin/node ./node_modules/.bin/tsc --noEmit` → EXIT:0 (zero type errors)

### Tests run
None automated.

### Known risks / assumptions
- `telegramChatId` absent → endpoint behaves exactly as before (bot's `/auth` command unaffected).
- Non-numeric `telegramChatId` → 400 returned before `loginWithPrivy` is called.
- FE change (Step 5 of the plan) lives in `fe/privy-auth` and must be applied separately.
