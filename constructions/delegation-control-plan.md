# Delegation Control — BE Plan

## Goal
After `buildAndShowConfirmation` resolves the spending token, the bot constructs a typed ZeroDev delegation request, logs it to Telegram, and exposes it via HTTP so the FE can display it and prompt the user to sign.

---

## New: ZeroDev Message Type Enum + Schemas

**`src/helpers/enums/zerodevMessageType.enum.ts`**
```typescript
export enum ZERODEV_MESSAGE_TYPE {
  ERC20_SPEND = 'ERC20_SPEND',
  // future: NATIVE_SPEND, CALL_CONTRACT, ...
}
```

**`src/use-cases/interface/output/delegation/zerodevMessage.types.ts`**
One Zod schema per enum value, plus a discriminated union:

```typescript
import { z } from 'zod';
import { ZERODEV_MESSAGE_TYPE } from '../../../helpers/enums/zerodevMessageType.enum';

export const Erc20SpendMessageSchema = z.object({
  type: z.literal(ZERODEV_MESSAGE_TYPE.ERC20_SPEND),
  sessionKeyAddress: z.string(),   // 0x…  — the keypair address from onboarding
  tokenAddress: z.string(),        // 0x…  — ERC20 contract
  maxAmountRaw: z.string(),        // BigInt as decimal string (no float precision loss)
  validUntilEpoch: z.number(),     // now + DELEGATION_TTL_SECONDS
  chainId: z.number(),
});
export type Erc20SpendMessage = z.infer<typeof Erc20SpendMessageSchema>;

// Discriminated union — add new message types here
export const ZerodevMessageSchema = z.discriminatedUnion('type', [
  Erc20SpendMessageSchema,
]);
export type ZerodevMessage = z.infer<typeof ZerodevMessageSchema>;
```

---

## New: `DelegationRequestBuilder` (output adapter)

**`src/adapters/implementations/output/delegation/delegationRequestBuilder.ts`**

```typescript
export class DelegationRequestBuilder {
  buildErc20Spend(opts: {
    sessionKeyAddress: string;
    tokenAddress: string;
    maxAmountRaw: string;
    chainId: number;
  }): ZerodevMessage {
    return Erc20SpendMessageSchema.parse({
      type: ZERODEV_MESSAGE_TYPE.ERC20_SPEND,
      sessionKeyAddress: opts.sessionKeyAddress,
      tokenAddress: opts.tokenAddress,
      maxAmountRaw: opts.maxAmountRaw,
      validUntilEpoch: Math.floor(Date.now() / 1000) + parseInt(process.env.DELEGATION_TTL_SECONDS ?? '604800'),
      chainId: opts.chainId,
    });
  }
}
```

---

## New: `pending_delegations` DB table

| Column              | Type      | Notes                                  |
|---------------------|-----------|----------------------------------------|
| `id`                | uuid PK   |                                        |
| `user_id`           | uuid FK   | → users                                |
| `zerodev_message`   | jsonb     | Full `ZerodevMessage` payload          |
| `status`            | text      | `pending` \| `signed` \| `expired`    |
| `created_at_epoch`  | bigint    |                                        |
| `expires_at_epoch`  | bigint    | = `validUntilEpoch`                    |

Repo interface: `IPendingDelegationDB` — `create`, `findLatestByUserId`, `markSigned`.

---

## Handler change — `buildAndShowConfirmation`

After calldata is built, inject this step before the confirmation message:

```typescript
// 1. Look up session key address for this user
const profile = await userProfileRepo.findByUserId(userId);
if (!profile?.sessionKeyAddress) throw new Error('No session key registered');

// 2. Determine spending token + raw amount
const fromToken = resolvedFrom;        // ITokenRecord
const amountRaw = toRaw(session.partialParams.amountHuman as string, fromToken.decimals);

// 3. Build delegation request
const delegationMsg = delegationBuilder.buildErc20Spend({
  sessionKeyAddress: profile.sessionKeyAddress,
  tokenAddress: fromToken.address,
  maxAmountRaw: amountRaw,
  chainId: this.chainId,
});

// 4. Persist
await pendingDelegationRepo.create({ userId, zerodevMessage: delegationMsg });

// 5. Log to Telegram
await ctx.reply(buildDelegationPrompt(delegationMsg));
// ^ human-readable: "Approve bot to spend X TOKEN for 7 days in the Aegis app"
```

The existing `buildConfirmationMessage` reply follows after.

---

## New HTTP endpoint: `GET /delegation/pending`

Auth: JWT (same pattern as `/portfolio`).

Returns the latest `pending` delegation record for the authenticated user:
```json
{
  "id": "uuid",
  "zerodevMessage": { "type": "ERC20_SPEND", ... }
}
```

FE polls this after the Telegram prompt appears.

**`POST /delegation/:id/signed`** — FE calls this once the user signs on-chain; sets status → `signed`.

---

## New env var

| Variable                 | Default  | Purpose                            |
|--------------------------|----------|------------------------------------|
| `DELEGATION_TTL_SECONDS` | `604800` | Session key validity window (7 d)  |

---

## Summary of new files

```
src/helpers/enums/zerodevMessageType.enum.ts
src/use-cases/interface/output/delegation/zerodevMessage.types.ts
src/use-cases/interface/output/repository/pendingDelegation.repo.ts
src/adapters/implementations/output/delegation/delegationRequestBuilder.ts
src/adapters/implementations/output/sqlDB/repositories/pendingDelegation.repo.ts
```

Modified:
- `handler.ts` — `buildAndShowConfirmation` step injection
- `http/HttpApiServer.ts` — two new routes
- `schema.ts` + migration — `pending_delegations` table
- `assistant.di.ts` — wire new deps
