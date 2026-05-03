# Plan: Self-derived Smart Account Address (BE)

**Status:** Planned
**Date:** 2026-05-03
**Scope:** Backend only (`be/`). Companion FE plan: `fe/privy-auth/constructions/2026-05-03-self-derived-sca.md`.

---

## 1. Goal

Stop depending on Privy's hosted smart-wallets product to *tell us* the user's SCA address. Compute the SCA address ourselves from the Privy EOA, with a deterministic, pinned-config derivation function shared between FE and BE.

**Primary functional win:** fixes the handle-resolution bug. Today `resolverEngine.ts:84` and `sendCapability.ts:709` resolve `@handle → telegramUserId → Privy.getOrCreateWalletByTelegramId → embedded EOA address`, then return the EOA as the recipient address. The recipient's actual SCA is never computed; for un-onboarded recipients there is no SCA in the DB. This plan makes recipient resolution: `eoa → deriveScaAddress(eoa) → SCA`.

**Architectural win:** the AA stack constants (factory address, kernel version, salt) live in one config module that both sides import. Privy SDK / dashboard changes can no longer silently change a user's SCA out from under us.

## 2. Non-goals

- No change to session-key install (FE-side, already self-built).
- No change to auto-sign / manual-sign UX.
- No change to off-chain spend-limit enforcement (`Erc20SpendMessage`, `/delegation/grant`).
- No change to DB schema. `user_profiles.smart_account_address` stays the canonical record for already-onboarded users.
- No change to validator policy. `toSudoPolicy({})` stays as-is — scope continues to be enforced server-side per `ApprovalOnboarding.tsx:213-214`. A separate, optional, future plan can swap this for `toCallPolicy` if/when threat model widens.
- No new contract deployment. SCAs remain counterfactual; first-spend deploy is paid by the existing Pimlico paymaster, unchanged.

## 3. Trust model & invariants

| Invariant | Why it matters |
|---|---|
| `deriveScaAddress(eoa, chainId)` is pure (no signing, no RPC writes) and deterministic. | If it ever drifts, existing onboarded users' DB-recorded `smartAccountAddress` no longer equals what we compute → effective fund-loss UX. |
| `AA_CONFIG.index = 0n` matches Privy's hosted smart-wallets default. | Required for derivation to agree with all *already-onboarded* users' stored SCAs. **Verified empirically before cutover** — see §4. |
| DB row is canonical when present. Derivation is fallback only. | Forward-compatibility: if Privy ever changes scheme (or we change `AA_CONFIG`), pinned DB rows protect existing users. |
| Privy stays the EOA + identity authority. | We are not building wallet custody. Recipient EOAs are still provisioned by `client.importUser({ createEthereumWallet: true })` in `privyServer.adapter.ts:108-113`. |

## 4. Verification gate (blocking — must pass before any cutover)

Run a one-off script that proves `AA_CONFIG.index = 0n` matches Privy's default. Without this, *every* already-onboarded user's stored `smartAccountAddress` could disagree with our derivation.

**Script:** `be/scripts/verify-sca-derivation.ts` (one-off, not committed long-term).

```
1. Pull all user_profiles rows where eoa_address IS NOT NULL AND smart_account_address IS NOT NULL.
2. For each row, call deriveScaAddress(eoaAddress, chainId).
3. Compare against stored smart_account_address (case-insensitive).
4. Report: { matched, mismatched, total }.
```

**Pass criterion:** 100% match across at least 5 rows, ideally all rows. Any mismatch → halt; investigate Privy's actual scheme before proceeding.

If mismatch is found: do NOT ship the FE switch. The BE recipient-resolution change (§7.4) can still ship because un-onboarded recipients have no stored SCA to disagree with — but new recipients would land at addresses different from what they'd see in another Privy-Kernel app. Decide whether that's acceptable or whether to abort.

## 5. New module: `be/src/helpers/aaConfig.ts`

Single source of truth for the AA stack. Mirrors the FE module of the same name.

```ts
import { entryPoint07Address } from "viem/account-abstraction";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";

export const AA_CONFIG = {
  entryPointVersion: "0.7" as const,
  entryPointAddress: entryPoint07Address,
  kernelVersion: KERNEL_V3_1,
  /**
   * Salt used for Kernel CREATE2 address derivation.
   * Pinned to 0n to match Privy's hosted smart-wallets default for Kernel V3.1.
   * VERIFIED 2026-05-?? against N onboarded users — see verify-sca-derivation.ts run log.
   * Changing this constant changes every NEW user's SCA. Existing users are pinned in DB
   * and unaffected; the safety net is the DB-canonical read in resolverEngine.
   */
  index: 0n,
} as const;

export function getAaEntryPoint() {
  return getEntryPoint(AA_CONFIG.entryPointVersion);
}
```

## 6. New module: `be/src/helpers/deriveScaAddress.ts`

```ts
import { addressToEmptyAccount, createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createPublicClient, http } from "viem";
import { AA_CONFIG, getAaEntryPoint } from "./aaConfig";
import { getRpcUrlForChain, getViemChain } from "./chainConfig";  // existing helpers
import { createLogger } from "./observability/logger";

const log = createLogger("deriveScaAddress");

/**
 * Compute the Kernel V3.1 SCA address that corresponds to a given Privy embedded EOA
 * on a given chain. Pure derivation — no signing, no transactions.
 *
 * Internally builds an empty Kernel account scaffolding so that the @zerodev/sdk
 * runs the same address calculation it would for a real account, but with no
 * private key bound. The returned address is counterfactual: the contract is not
 * deployed until the first UserOp from this account.
 */
export async function deriveScaAddress(
  eoa: `0x${string}`,
  chainId: number,
): Promise<`0x${string}`> {
  const chain = getViemChain(chainId);
  const publicClient = createPublicClient({
    chain,
    transport: http(getRpcUrlForChain(chainId)),
  });
  const entryPoint = getAaEntryPoint();

  const ownerSigner = await addressToEmptyAccount(eoa);
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    entryPoint,
    signer: ownerSigner,
    kernelVersion: AA_CONFIG.kernelVersion,
  });

  const account = await createKernelAccount(publicClient, {
    entryPoint,
    plugins: { sudo: ecdsaValidator },
    kernelVersion: AA_CONFIG.kernelVersion,
    index: AA_CONFIG.index,
  });

  log.debug({ eoa, chainId, sca: account.address }, "sca-derived");
  return account.address;
}
```

A small in-process LRU around this function (key: `${chainId}:${eoa}`) is recommended — derivation is deterministic and fairly cheap but does involve a `getCode` RPC under the hood; cache TTL can be hours.

## 7. File-level changes

### 7.1 `aaConfig.ts` — new (§5)
### 7.2 `deriveScaAddress.ts` — new (§6)

### 7.3 `chainConfig.ts` — add helper if missing

Verify `getRpcUrlForChain(chainId)` and `getViemChain(chainId)` exist as exported helpers. If not, add thin wrappers around the existing `CHAIN_REGISTRY`. No structural changes.

### 7.4 `userProfile.repo.ts` (`adapters/.../sqlDB/repositories/`) — add `findByEoaAddress`

```ts
async findByEoaAddress(eoa: string): Promise<IUserProfile | undefined> {
  const rows = await this.db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.eoaAddress, eoa.toLowerCase()))  // verify storage casing
    .limit(1);
  return rows[0] ? mapRowToProfile(rows[0]) : undefined;
}
```

Add the matching method signature to `use-cases/interface/output/repository/userProfile.repo.ts`.

**Note:** confirm the existing storage casing for `eoa_address` (lowercase per ETH norm? mixed?). Match the comparison accordingly. Add a check on the write path (`upsert`/`update`) that the value is canonicalized to lowercase before insert, if it isn't already.

### 7.5 `resolverEngine.ts` (`adapters/.../resolver/`) — recipient resolution

Replace lines 83-89:

```ts
recipientAddress =
  await this.privyAuthService.getOrCreateWalletByTelegramId(telegramUserId);
recipientTelegramUserId = telegramUserId;
recipientHandle = handle;
log.info({ step: "wallet-resolved", telegramUserId, wallet: recipientAddress }, "wallet resolved from Telegram handle");
```

with:

```ts
const recipientEoa = await this.privyAuthService.getOrCreateWalletByTelegramId(telegramUserId);
const existingProfile = await this.userProfileDB.findByEoaAddress(recipientEoa);

if (existingProfile?.smartAccountAddress) {
  recipientAddress = existingProfile.smartAccountAddress;
  log.info({ step: "wallet-resolved", source: "db", telegramUserId, wallet: recipientAddress }, "recipient SCA from DB");
} else {
  recipientAddress = await deriveScaAddress(recipientEoa as `0x${string}`, chainId);
  log.info({ step: "wallet-resolved", source: "derived", telegramUserId, eoa: recipientEoa, wallet: recipientAddress }, "recipient SCA derived");
}

recipientTelegramUserId = telegramUserId;
recipientHandle = handle;
```

Constructor: add `IUserProfileDB` to the DI list (the interface is already imported on line 7; the field exists at `userProfileDB` already used on line 33 for `findByUserId(userId)`). No constructor change needed.

### 7.6 `sendCapability.ts` (`adapters/.../capabilities/`) — duplicate fix at line 709

Apply the same change. The capability has its own copy of the resolution logic (the `resolveRecipientHandle` method, lines 686-732). After this plan, both paths agree.

Constructor inject `userProfileDB` if it isn't already; check `assistant.di.ts` and add the dependency wiring if needed. (The DI module already constructs `userProfileDB` for other use cases — likely a one-line add.)

### 7.7 `assistant.di.ts` (`adapters/inject/`) — wiring

Verify both `resolverEngine` and `sendCapability` receive `userProfileDB`. The repo is already constructed elsewhere in the same module; pass it through.

### 7.8 No changes

Untouched: `httpServer.ts`, `applySessionKeyApproval`, all other capabilities, all use cases, schema, all other adapters.

## 8. Migration / cutover order

1. **Land §5-§7.4 (helpers + new repo method).** Self-contained, no behavior change. Includes unit tests for `deriveScaAddress` (single-chain, known EOA → known SCA from production DB).
2. **Run verification script (§4) against production DB read replica.** Block §7.5/§7.6 cutover until 100% match.
3. **Land §7.5 + §7.6 + §7.7.** Recipient resolution now goes DB-first, derivation-fallback. Existing onboarded users: DB hit (unchanged behavior). Un-onboarded recipients: derivation hit (was: wrong EOA returned; now: correct counterfactual SCA).
4. **Soak for 1-2 weeks.** Monitor recipient-side success: do funds sent to derived SCAs land correctly when the recipient eventually onboards? Add a metric `recipient_resolution_source{source=db|derived}` to track frequencies.
5. **Coordinate FE cutover** — FE plan §6 step. Only after BE is stable.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Salt assumption wrong → derivation diverges from Privy's | Verification gate (§4); DB-canonical fallback protects existing users |
| New ZeroDev SDK version subtly changes default index | `AA_CONFIG.index` is explicit; pin SDK version in `package.json`; add unit test that derives a known fixture |
| `findByEoaAddress` casing mismatch returns null incorrectly | Lowercase canonicalization on read AND write; backfill audit query in §1 of cutover |
| `deriveScaAddress` is called on hot path, adds latency | LRU cache (per §6); TTL ~1h; cache key `${chainId}:${eoa}` |
| Recipient receives funds but later onboards via FE that derives a different address | If FE plan ships with the *same* `aaConfig`, this cannot happen. If FE plan delays, BE-derived SCA must equal Privy's hosted SCA — which is exactly what the §4 gate proves. |
| BE adds a per-chain RPC dependency for derivation | Already have RPC URLs in `chainConfig`; reuse |

## 10. Rollback

- Each step is independently revertible.
- `findByEoaAddress` addition is additive — no cleanup needed if reverted.
- `resolverEngine.ts` / `sendCapability.ts` change reverts to the prior 2-line block.
- `aaConfig.ts` and `deriveScaAddress.ts` can stay as dead code with no impact.
- DB rows are unchanged in either direction — no data migration.

## 11. Out of scope (mentioned for context)

- Tightening on-chain validator from `toSudoPolicy({})` to `toCallPolicy` — separate plan, separate trust-model decision.
- Multi-chain SCA strategy (per-chain factory addresses, per-chain index variation). Today everything runs on one chain at a time per request; if that ever fans out, `AA_CONFIG` needs to become per-chain.
- Replacing `getOrCreateWalletByTelegramId` with a no-create variant (`getUserByTelegramUserId` only) for read-only paths to avoid spam-provisioning. Worth doing later but unrelated to SCA derivation.
