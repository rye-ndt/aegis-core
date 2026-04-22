# Backend — Frictionless Delegation Flow

## Context

Revamp the signing flow so the bot executes transactions autonomously using a pre-approved
sudo session key. Users only open the Mini App when their spending limits are exhausted.
Enforcement is server-side: DB-stored limits are checked before every UserOp submission.
Redis AegisGuard cache is retired and replaced by a persistent `token_delegations` table.

---

## Group 1: Data Layer

### 1. `schema.ts` — add `tokenDelegations` table

```
id             uuid  pk
userId         uuid  not null
tokenAddress   text  not null        -- ERC20 address or 0xEeee…EEeE for native
tokenSymbol    text  not null
tokenDecimals  int   not null
limitRaw       text  not null        -- bigint as decimal string
spentRaw       text  not null  default '0'
validUntil     int   not null        -- unix epoch seconds
createdAtEpoch int   not null
updatedAtEpoch int   not null

unique(userId, tokenAddress)
```

### 2. `ITokenDelegationDB` interface
`src/use-cases/interface/output/repository/tokenDelegation.repo.ts`

```typescript
upsertMany(userId: string, delegations: NewTokenDelegation[]): Promise<void>
findActiveByUserId(userId: string): Promise<TokenDelegation[]>   // validUntil > now
addSpent(userId: string, tokenAddress: string, amountRaw: string): Promise<void>
findByUserIdAndToken(userId: string, tokenAddress: string): Promise<TokenDelegation | null>
```

### 3. `tokenDelegation.repo.ts` — Drizzle implementation
`src/adapters/implementations/output/sqlDB/repositories/tokenDelegation.repo.ts`

- `upsertMany`: Drizzle `onConflictDoUpdate` on `(userId, tokenAddress)`.
  On conflict: update `limitRaw`, reset `spentRaw` to `'0'`, update `validUntil` and `updatedAtEpoch`.
- `addSpent`: fetch current row, BigInt-add `amountRaw`, update in same statement with
  `WHERE id = :id` to avoid concurrent overwrites (Postgres serialises single-row updates).

### 4. Wire into `DrizzleSqlDB` and `assistant.di.ts`

Add `tokenDelegationRepo` property to `DrizzleSqlDB`.
Inject into: `AuthUseCaseImpl`, `IntentUseCaseImpl`, `TelegramAssistantHandler`.

### 5. Run migration

```
npm run db:generate && npm run db:migrate
```

---

## Group 2: API Endpoints

### 6. `GET /delegation/approval-params` (JWT required)

Query params (optional): `tokenAddress`, `amountRaw` — for re-approval context.

Logic:
1. Fetch USDC and USDT addresses from `token_registry` by `(symbol, chainId)`.
2. Native token: hardcoded `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`, decimals 18.
3. Build default list:

   | Token | suggestedLimitRaw        | validUntil   |
   |-------|--------------------------|--------------|
   | USDC  | `500 * 10^6`             | now + 30 days |
   | USDT  | `500 * 10^6`             | now + 30 days |
   | AVAX  | `50 * 10^18`             | now + 30 days |

4. If `tokenAddress` query param present: replace the matching entry (or append if not in list)
   with `{ tokenAddress, suggestedLimitRaw: amountRaw }`. Frontend uses this for re-approval.

Response:
```json
{ "tokens": [{ "tokenAddress", "tokenSymbol", "tokenDecimals", "suggestedLimitRaw", "validUntil" }] }
```

### 7. `POST /delegation/grant` (JWT required)

Replaces `POST /aegis-guard/grant`.

Body: `{ delegations: [{ tokenAddress, tokenSymbol, tokenDecimals, limitRaw, validUntil }] }`
Action: `tokenDelegationDB.upsertMany(userId, delegations)`
Response: `200 { ok: true }`

### 8. `GET /delegation/grant` (JWT required)

Action: `tokenDelegationDB.findActiveByUserId(userId)`
Response: `{ delegations: TokenDelegation[] }`

Used internally by the execution estimator and externally by the frontend to decide
whether the onboarding flow should be shown.

### 9. Register all three routes in `httpServer.ts`

Remove `POST /aegis-guard/grant` from the route table (see Group 7 cleanup).

---

## Group 3: Proactive Onboarding Trigger

### 10. `auth.usecase.ts` — `loginWithPrivy` post-login hook

After user upsert/find:

```typescript
const delegations = await tokenDelegationDB.findActiveByUserId(userId);
if (delegations.length === 0 && input.telegramChatId) {
  await telegramNotifier.sendMessage(
    input.telegramChatId,
    "Hey! To let me act on your behalf, I need a one-time permission.\n" +
    "Tap the button below — it takes about 10 seconds.",
    { webAppButton: { label: "Confirm", url: MINI_APP_URL } },
  );
}
```

Inject `ITokenDelegationDB` and `ITelegramNotifier` into `AuthUseCaseImpl` constructor.
Wire both in `assistant.di.ts`.

`ITelegramNotifier` interface: `src/use-cases/interface/output/telegramNotifier.interface.ts` (already exists).
`BotNotifier` implementation: `src/adapters/implementations/output/telegram/botNotifier.ts` (already exists).

---

## Group 4: Execution Estimator

### 11. `IExecutionEstimator` interface
`src/use-cases/interface/output/executionEstimator.interface.ts`

```typescript
export interface EstimationInput {
  delegations: {
    tokenAddress: string;
    tokenSymbol: string;
    tokenDecimals: number;
    limitRaw: string;
    spentRaw: string;
    validUntil: number;   // unix epoch seconds
  }[];
  intentTokenAddress: string;
  intentTokenSymbol: string;
  intentAmountRaw: string;
  intentAmountHuman: string;
}

export interface EstimationResult {
  shouldApproveMore: boolean;
  displayMessage: string;          // Telegram-ready, friendly
  tokenAddress?: string;           // populated only when shouldApproveMore = true
  humanReadableAmount?: string;    // populated only when shouldApproveMore = true
}

export interface IExecutionEstimator {
  estimate(input: EstimationInput): Promise<EstimationResult>;
}
```

### 12. Zod schema for `EstimationResult`

```typescript
export const EstimationResultSchema = z.object({
  shouldApproveMore: z.boolean(),
  displayMessage: z.string(),
  tokenAddress: z.string().optional(),
  humanReadableAmount: z.string().optional(),
});
```

### 13. `openai.executionEstimator.ts`
`src/adapters/implementations/output/intentParser/openai.executionEstimator.ts`

OpenAI call with `response_format: { type: 'json_schema', json_schema: { strict: true, schema: zodToJsonSchema(EstimationResultSchema) } }`.

System prompt:
```
You are a spending-limit checker for a DeFi trading bot.
Given a list of token delegations (each with limitRaw, spentRaw, validUntil in unix seconds)
and a proposed spend (token symbol, intentAmountRaw, intentAmountHuman), determine:
  1. Does an active (validUntil > now), non-expired delegation exist for the token?
  2. Is remaining capacity (limitRaw - spentRaw) >= intentAmountRaw?
If both conditions are met → shouldApproveMore = false, displayMessage = brief neutral confirmation.
Otherwise → shouldApproveMore = true, displayMessage = friendly explanation of what is needed,
  tokenAddress = the address of the blocking token,
  humanReadableAmount = suggested top-up in human-readable units.
Current unix timestamp: {now}.
Respond only with valid JSON matching the schema.
```

Parse response: `EstimationResultSchema.parse(JSON.parse(content))`.

### 14. Wire `IExecutionEstimator` into `assistant.di.ts`

---

## Group 5: Autonomous Execution

### 15. `intent.usecase.ts` — implement `confirmAndExecute`

Remove stub. Implementation:

```
1. Accept calldata directly from the handler (avoid redundant DB re-fetch).
   Signature change: confirmAndExecute({ intentId, userId, calldata, tokenAddress?, amountRaw? })

2. Fetch user profile → smartAccountAddress, sessionKeyAddress.

3. Use BOT_PRIVATE_KEY env var as the session key signer.

4. Build UserOp:
   IUserOperationBuilder.build({ to: calldata.to, data: calldata.data, value: calldata.value,
                                  smartAccountAddress })

5. Submit via bundler → userOpHash.

6. waitForReceipt(userOpHash) → txHash.

7. Save intent_executions row:
   { intentId, userId, smartAccountAddress, solverUsed, simulationPassed: true,
     userOpHash, txHash, status: CONFIRMED, createdAtEpoch, updatedAtEpoch }

8. Update intent status → CONFIRMED.

9. If tokenAddress and amountRaw provided:
   tokenDelegationDB.addSpent(userId, tokenAddress, amountRaw)

10. Return { humanSummary: txResultParser.parse(txHash), txHash }
```

`ISmartAccountService`, `IUserOperationBuilder`, `IPaymasterService`, `ISessionKeyService`
interfaces already exist in `use-cases/interface/output/blockchain/`.
Adapter implementations are in `adapters/implementations/output/blockchain/`.
Inject them into `IntentUseCaseImpl` constructor and wire in `assistant.di.ts`.

---

## Group 6: Wire Estimator into Handler

### 16. `handler.ts` — update both confirmation methods

`buildAndShowConfirmation` and `buildAndShowConfirmationFromResolved`:
After calldata is built, replace the `signingRequestUseCase.createRequest` call with:

**Step A — check if ERC20 spend**
```
if resolvedFrom is null or resolvedFrom.isNative:
  → skip estimator, go to Step C
```

**Step B — run estimator**
```typescript
const delegations = await tokenDelegationDB.findActiveByUserId(userId);
const result = await executionEstimator.estimate({
  delegations,
  intentTokenAddress: resolvedFrom.address,
  intentTokenSymbol: resolvedFrom.symbol,
  intentAmountRaw: session.partialParams.amountRaw as string,
  intentAmountHuman: session.partialParams.amountHuman as string,
});
```

**Step C — sufficient delegation → autonomous execution**
```typescript
if (!result.shouldApproveMore) {
  const execResult = await intentUseCase.confirmAndExecute({
    intentId,
    userId,
    calldata,
    tokenAddress: resolvedFrom?.address,
    amountRaw: session.partialParams.amountRaw as string,
  });
  await ctx.reply(execResult.humanSummary);
  return;
}
```

**Step D — insufficient delegation → re-approval prompt**
```typescript
const rawForReapproval =
  (BigInt(Math.max(Number(session.partialParams.amountHuman), 100)) *
   10n ** BigInt(resolvedFrom.decimals)).toString();
const reapprovalUrl =
  `${MINI_APP_URL}?reapproval=1&tokenAddress=${resolvedFrom.address}&amountRaw=${rawForReapproval}`;
const keyboard = new InlineKeyboard().webApp('Approve More', reapprovalUrl);
await ctx.reply(result.displayMessage, { reply_markup: keyboard });
```

### 17. Remove old `signingRequestUseCase.createRequest` calls from both confirmation paths

The SSE `/events` endpoint and `POST /sign-response` can stay for now as edge-case fallbacks.

---

## Group 7: Cleanup

### 18. Remove `IAegisGuardCache` references

Replace all `getGrant` / `addSpent` / `saveGrant` call sites with `ITokenDelegationDB` equivalents.

### 19. Delete Redis AegisGuard cache

- `src/adapters/implementations/output/cache/redis.aegisGuard.ts`
- `src/use-cases/interface/output/cache/aegisGuard.cache.ts`
- Remove from `assistant.di.ts`

### 20. Remove `POST /aegis-guard/grant` from `httpServer.ts`

---

## Execution Order

```
BE 1–5    schema + repo + migration            (prerequisite for everything)
BE 6–9    API endpoints                        (prerequisite for FE API calls)
BE 10     proactive auth prompt                (depends on BE 1–5)
BE 11–14  estimator                            (can overlap with BE 6–10)
BE 15     autonomous execution                 (depends on BE 1–5) ← parallel with FE 21–23
BE 16–17  wire estimator into handler          (depends on BE 11–14 and BE 15)
BE 18–20  cleanup                              (last BE step)

FE 21–23  remove password gate                 (independent of BE — can run in parallel with BE 15)
FE 24–25  ApprovalOnboarding component         (depends on BE 6–9 being live)
FE 26     App.tsx flow changes                 (depends on FE 24)
FE 27–30  cleanup                              (last FE step)
```

FE plan details (items 21–30) are in `fe/privy-auth/constructions/frictionless-delegation-plan.md`.
