# Migration: ZeroDev infra → Pimlico (bundler + paymaster)

**Status:** Planned
**Author / date:** 2026-04-27
**Scope:** Frontend only (`fe/privy-auth/`). Backend is unaffected at the code level — only secret values change.

---

## 1. Goal

Replace the **infrastructure layer** (bundler RPC + paymaster RPC) provided by ZeroDev with **Pimlico**, in order to get pay-as-you-go pricing on Avalanche mainnet (chain 43114). ZeroDev's $69/mo Pro plan is required for any ZeroDev mainnet RPC traffic; Pimlico is PAYG with a free tier.

**Non-goal:** changing the smart-account contract, validators, session-key flow, or serialized blob format.

## 2. What is kept vs. swapped

The `@zerodev/*` npm packages are **open-source SDK libraries** that produce calls to a standard ERC-4337 bundler/paymaster. We keep them.

### KEEP (do not touch)
- `@zerodev/sdk` — Kernel v3.1 account, `createKernelAccount`, `createKernelAccountClient`, `addressToEmptyAccount`, `getEntryPoint`, `KERNEL_V3_1`.
- `@zerodev/ecdsa-validator` — `signerToEcdsaValidator` (sudo / Privy EOA owner).
- `@zerodev/permissions` — `toPermissionValidator`, `toECDSASigner`, `toSudoPolicy`, `serializePermissionAccount`, `deserializePermissionAccount`.
- All session-key install logic, the serialized blob format, AES-GCM encryption, Telegram CloudStorage layout.
- Backend `ZerodevMessage` JSON envelope name (it's a wire-format label, not SDK usage). **Do not rename in this migration** — out of scope.
- All existing on-chain user smart accounts and stored session-key blobs remain valid. **No user re-onboarding.**

### SWAP
- Bundler RPC URL `VITE_ZERODEV_RPC` → `VITE_PIMLICO_BUNDLER_URL`.
- Paymaster RPC URL `VITE_PAYMASTER_URL` → `VITE_PIMLICO_PAYMASTER_URL`.
- `createZeroDevPaymasterClient` (from `@zerodev/sdk`) → `createPimlicoClient` (from `permissionless/clients/pimlico`). `permissionless` is already a dep.
- Backend env vars `AVAX_BUNDLER_URL` / `AVAX_PAYMASTER_URL` (referenced in `be/src/helpers/chainConfig.ts`) — point at Pimlico URLs. No backend code change.

## 3. File-level changes

### 3.1 `fe/privy-auth/src/utils/crypto.ts` (single source of swap)

Two functions change. **Everything else in the file stays.**

**`installSessionKey(...)`** — only rename the RPC parameter for clarity. The `publicClient` should point at a generic chain RPC (the bundler URL works, but a public RPC is also fine). No SDK call changes.

```ts
// before
zerodevRpc: string,
// after
bundlerRpc: string,
```

**`createSessionKeyClient(...)`** — replace the paymaster client construction.

```ts
// remove
import { createKernelAccount, createKernelAccountClient, addressToEmptyAccount, createZeroDevPaymasterClient } from '@zerodev/sdk';

// after — drop createZeroDevPaymasterClient, add Pimlico client
import { createKernelAccount, createKernelAccountClient, addressToEmptyAccount } from '@zerodev/sdk';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { entryPoint07Address } from 'viem/account-abstraction';

// inside createSessionKeyClient — replace the paymaster wiring:
const pimlicoClient = paymasterUrl
  ? createPimlicoClient({
      transport: http(paymasterUrl),
      entryPoint: { address: entryPoint07Address, version: '0.7' },
    })
  : null;

return createKernelAccountClient({
  account,
  chain: avalancheFuji,                  // ⚠ see Guardrail G1 below
  bundlerTransport: http(bundlerRpc),
  ...(pimlicoClient && {
    paymaster: {
      getPaymasterData: (userOp) => pimlicoClient.getPaymasterData(userOp),
      getPaymasterStubData: (userOp) => pimlicoClient.getPaymasterStubData(userOp),
    },
    // optional: use Pimlico's gas oracle to avoid bundler default gas surprises
    userOperation: {
      estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  }),
});
```

Notes:
- `permissionless` is already a dep of `fe/privy-auth/`. No new package install required for the client.
- `createPimlicoClient` exposes both `getPaymasterData` / `getPaymasterStubData` (paymaster RPC) **and** `getUserOperationGasPrice` (bundler gas oracle). The same Pimlico URL serves both bundler and paymaster RPC methods on one endpoint, but Pimlico also accepts split URLs — keep them split (two env vars) for symmetry with the current setup.

### 3.2 `fe/privy-auth/src/hooks/useDelegatedKey.ts`

Rename the env-var read; nothing else.

```ts
// before
const zerodevRpc = (import.meta.env.VITE_ZERODEV_RPC as string) ?? '';
if (!zerodevRpc) throw new Error('VITE_ZERODEV_RPC is not set');
// ...
installSessionKey(provider, signerAddress, sessionPrivateKey, sessionKeyAddress, zerodevRpc);

// after
const bundlerRpc = (import.meta.env.VITE_PIMLICO_BUNDLER_URL as string) ?? '';
if (!bundlerRpc) throw new Error('VITE_PIMLICO_BUNDLER_URL is not set');
// ...
installSessionKey(provider, signerAddress, sessionPrivateKey, sessionKeyAddress, bundlerRpc);
```

### 3.3 `fe/privy-auth/src/components/handlers/SignHandler.tsx`

Lines 16–17, 103–104, 116–117, 205–206. Mechanical rename of constant + env-var name. The `bundler: set/MISSING` debug rows in JSX should keep working with the new constants.

```ts
const BUNDLER_URL   = (import.meta.env.VITE_PIMLICO_BUNDLER_URL   as string) ?? '';
const PAYMASTER_URL = (import.meta.env.VITE_PIMLICO_PAYMASTER_URL as string) ?? '';
```

### 3.4 `fe/privy-auth/src/components/handlers/YieldDepositHandler.tsx`

Same rename as SignHandler. Lines 15–16, 104.

### 3.5 `fe/privy-auth/.env*` (and Vite types if present)

Update local and deploy environments:

```
VITE_PIMLICO_BUNDLER_URL=https://api.pimlico.io/v2/43114/rpc?apikey=<KEY>
VITE_PIMLICO_PAYMASTER_URL=https://api.pimlico.io/v2/43114/rpc?apikey=<KEY>
```

(`/v2/<chainId>/rpc` is Pimlico's per-chain endpoint format — confirm exact path against current Pimlico docs at decision time.)

If `vite-env.d.ts` exists and declares the old vars, update its `ImportMetaEnv` interface.

### 3.6 `fe/privy-auth/package.json`

No dependency changes required. `@zerodev/sdk`, `@zerodev/ecdsa-validator`, `@zerodev/permissions`, `permissionless` all stay. Do **not** remove the ZeroDev packages.

### 3.7 Backend (`be/`) — no code change

`be/src/helpers/chainConfig.ts` reads `AVAX_BUNDLER_URL` / `AVAX_PAYMASTER_URL` from env. Per `be/STATUS.md`, these are currently unused after the 2026-04-24 executor removal. If still wired anywhere, point them at Pimlico URLs in deploy env. No code edit.

The `ZerodevMessage` Zod schema, enums, and pending-delegation repo are wire-format labels for the FE↔BE delegation protocol. **Do not rename in this PR.**

## 4. Guardrails (read before implementing)

### G1 — Mainnet chain reference is hardcoded
`fe/privy-auth/src/utils/crypto.ts` currently hardcodes `avalancheFuji` (testnet, chain 43113) in three places: the `walletClient` chain, `publicClient` chain, and `createKernelAccountClient` chain. The user's failing request was on chain **43114 (Avalanche C-chain mainnet)**.

- This violates CLAUDE.md's "Chain-agnostic code" rule (`/be/src/helpers/chainConfig.ts` is the single source for the backend; the FE has no equivalent today).
- **Decide with the user before flipping**: this migration's stated scope is bundler/paymaster swap only. If the user also wants to move FE to mainnet in the same PR, swap `avalancheFuji` → `avalanche` from `viem/chains` in all three spots **and** confirm Privy embedded wallets are configured for mainnet. Otherwise, point Pimlico URLs at Fuji (chain 43113) and keep `avalancheFuji` until a separate mainnet-cutover PR.
- Do **not** silently change the chain. Surface this question.

### G2 — Do not remove `@zerodev/*` packages
Tempting cleanup, wrong move. They provide the Kernel account contract bindings, ECDSA validator, and permission/session-key modules. Removing them breaks every existing user's smart account.

### G3 — Preserve the serialized blob format
`serializePermissionAccount` / `deserializePermissionAccount` are unchanged. The blob in Telegram CloudStorage is a contract-bound proof; do not regenerate, re-encrypt under a new schema, or version-bump it. Any change here forces every user to re-onboard.

### G4 — Logging (MANDATORY per CLAUDE.md)
Every touched function must keep/gain logging via `createLogger('<ModuleName>')` from `src/utils/logger`. Do **not** use `console.*`.

- `crypto.ts` — module scope `const log = createLogger('crypto')`. Add `log.debug('createSessionKeyClient', { hasPaymaster: !!paymasterUrl })` and a `log.error('createSessionKeyClient failed', { err: msg })` in any new try/catch you introduce.
- `useDelegatedKey.ts`, `SignHandler.tsx`, `YieldDepositHandler.tsx` — already use the FE logger; keep `step` events at `started | submitted | succeeded | failed` with `requestId`.
- **Never log:** `serializedBlob`, `sessionPrivateKey`, Privy tokens, raw URLs that contain `?apikey=…`. If you must log a URL, strip the query string.
- FE logger signature is **message first**: `log.info('msg', { ... })`. (Backend is metadata-first — but no backend changes here.)

### G5 — Hexagonal boundary (backend)
No backend code touched. Do not introduce a `PimlicoClient` adapter or rename ports/types. The `ZerodevMessage` name is part of the existing wire contract — leave it.

### G6 — No fallback / no dual-provider mode
Do not add a feature flag to switch between ZeroDev and Pimlico. Per CLAUDE.md "no half-finished implementations" and "no backwards-compat shims". Cut over cleanly.

### G7 — Sponsorship policy
Today's setup is **unconditional sponsorship** (any UserOp with a configured paymaster URL gets sponsored). Pimlico's verifying paymaster sponsors based on policies configured in their dashboard or via a sponsorship-policy server. For launch:
- Configure a Pimlico **sponsorship policy** that allows all UserOps from the project (matches current behavior).
- This is a **dashboard configuration step**, not code. Document the policy ID in deploy notes.
- If/when you want allow-lists or per-user budgets, that's a separate change (a sponsorship-policy server or Pimlico policy rules).

### G8 — Gas estimation
Pimlico's bundler uses standard `eth_estimateUserOperationGas`. The optional `userOperation.estimateFeesPerGas` hook (using `pimlicoClient.getUserOperationGasPrice()`) is recommended on Avalanche to avoid sticky `maxPriorityFeePerGas` estimates that some bundlers default to. Include it.

### G9 — EntryPoint version pinning
Pimlico exposes both EntryPoint 0.6 and 0.7 endpoints. **You must use 0.7** to match the existing Kernel v3.1 accounts. Pass `entryPoint: { address: entryPoint07Address, version: '0.7' }` to `createPimlicoClient` (import `entryPoint07Address` from `viem/account-abstraction`). Mismatch → all UserOps revert.

### G10 — Testing
This swap touches the live signing path. Before merging:
1. Local: install session key against Fuji using new env vars, run a sponsored `sendTransaction` end-to-end through `SignHandler`.
2. Verify the sponsored UserOp lands on-chain (check tx hash on Snowtrace).
3. Test with `PAYMASTER_URL` empty — the client must still build and the tx must submit (user pays gas from SCA balance).
4. Test that an **existing** stored serialized blob still deserializes (back-compat sanity).
5. Yield deposit flow once via `YieldDepositHandler` (uses the same `createSessionKeyClient`).

### G11 — Status docs (per CLAUDE.md "After implementing")
Update `fe/privy-auth/status.md` with:
- **What:** swapped bundler/paymaster infra from ZeroDev to Pimlico; kept all `@zerodev/*` SDK packages.
- **Why:** ZeroDev mainnet RPC requires $69/mo plan; Pimlico is PAYG. Avalanche 43114 supported.
- **New convention:** env vars are now `VITE_PIMLICO_BUNDLER_URL` / `VITE_PIMLICO_PAYMASTER_URL`; the term "ZeroDev" remains only as the wire-format label `ZerodevMessage` on the FE↔BE delegation protocol — do not rename in unrelated PRs.

If `be/STATUS.md` mentions `AVAX_BUNDLER_URL` / `AVAX_PAYMASTER_URL` semantics, add a note that these now point at Pimlico endpoints (no code change).

## 5. Step-by-step execution

1. Confirm with the user: chain target (Fuji 43113 vs. mainnet 43114) — see G1.
2. Get Pimlico API key for the chosen chain; configure a sponsorship policy that mirrors current unconditional-sponsorship behavior (G7).
3. Set new env vars in local `.env`, deploy env, and any vite-env type file (3.5).
4. Edit `crypto.ts` per 3.1: rename param, replace paymaster client, add gas-price hook, pin EntryPoint 0.7 (G9).
5. Edit `useDelegatedKey.ts` (3.2), `SignHandler.tsx` (3.3), `YieldDepositHandler.tsx` (3.4) — env-var renames + constant renames.
6. Run G10 test matrix end-to-end. Do not skip step 4 (back-compat blob).
7. Update `fe/privy-auth/status.md` per G11.
8. Open PR. Do **not** remove old env vars from any deployed environment until cutover is verified — but do remove from code (G6).

## 6. Rollback

If Pimlico misbehaves post-cutover:
- Revert the FE PR (single commit, single-file diff in `crypto.ts` plus 3 mechanical renames).
- Restore old env-var names in deploy env, repoint at ZeroDev URLs.
- No on-chain state changes occur during this migration, so rollback is purely a deploy operation.

## 7. Out of scope (do not bundle into this PR)

- Mainnet cutover (unless explicitly requested; see G1).
- Renaming `ZerodevMessage` wire format on the BE.
- Removing the now-unused legacy bundler/paymaster code paths in BE noted in `be/STATUS.md` (separate cleanup).
- Tightening `toSudoPolicy({})` to a `toCallPolicy(...)` — the comment in `crypto.ts:141` flags this as a separate hardening task.
- ERC-20 paymaster (users pay gas in USDC) — separate feature.
