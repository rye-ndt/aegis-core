---
title: Wallet self-service — export EOA key + withdraw SCA USDC to EOA
date: 2026-05-06
scope: backend
status: planned
---

# Backend plan — Wallet self-service (export key + USDC withdraw)

## 1. Goal

Add two self-service controls to the FE Config tab:

1. **Export Private Key** — reveals the user's Privy embedded EOA private key (Privy-hosted iframe). **No backend involvement.** Listed here only so the construction is complete; nothing to build BE-side.
2. **Withdraw USDC to my wallet** — sweeps the user's SCA USDC balance to their controlling EOA, per chain (Avax 43114, BSC 56). Signed by the **sudo validator** (Privy EOA popup) on the FE, so this bypasses session-key off-chain limits by design — it must remain available even if the AI agent / session key is broken.

The BE work is small: one read-only endpoint that bundles everything the FE needs to construct a sweep transaction. **No new write endpoints, no new on-chain logic, no migration.**

## 2. Why this BE shape (and what we rejected)

### Chosen — `GET /wallet/withdraw/preview?chainId=X`

Returns the SCA address, EOA address, USDC token metadata, and the SCA's current USDC balance. One round-trip per chain.

- **Keeps BE the source of truth** for chain-specific values, per CLAUDE.md ("Chain-agnostic code... never inline chain IDs, RPC URLs, addresses").
- **Reuses existing BE primitives** — `chainConfig.ts:usdcEnvKey`, the existing public client / multicall infra used by capabilities.
- **One call gives the FE everything** it needs to build the `transfer(eoa, balance)` calldata locally. FE doesn't need to know USDC addresses.

### Rejected — extend `GET /portfolio` with token addresses

`PortfolioToken` (in `useAppData.tsx`) currently only carries `{ symbol, name, balance, usdValue }`. Adding `address`/`chainId`/`decimals` would touch a hot path used by `HomeTab` and risk regressions. Withdraw is a cold path — keep it on its own endpoint.

### Rejected — mirror USDC into FE `chainConfig.ts`

The `aaConfig.ts` mirror is tolerated because those values (entryPoint, kernel version, salt) are protocol-level constants. USDC addresses are deployment-level — duplicating them would mean two places to update on every new chain. Reject.

### Rejected — BE-side sweep endpoint that returns a signed UserOp

Would require BE to either custody a signing key (rejected per `self_derived_sca.md` §D) or hand back an unsigned UserOp the FE then signs — same number of round-trips as the chosen design but more BE complexity, and it gives the BE a place to censor sweeps. Sweep is a rescue primitive; it should depend on as little BE logic as possible.

## 3. Endpoint contract

### `GET /wallet/withdraw/preview`

**Query:** `chainId: number` (only `43114` and `56` accepted in v1; reject others with 400).

**Auth:** Same Privy-token scheme as `/portfolio` and `/delegation/grant` (existing middleware — no new auth work).

**Response 200:**

```ts
{
  chainId: 43114 | 56,
  scaAddress: `0x${string}`,        // user's smart account on this chain
  eoaAddress: `0x${string}`,        // user's Privy EOA (the withdraw destination)
  usdc: {
    address: `0x${string}`,         // resolved from chainConfig usdcEnvKey
    decimals: 6,                    // hardcoded in the helper, NOT inlined elsewhere
    symbol: 'USDC',
    balanceRaw: string,             // bigint serialized as decimal string
  },
}
```

**Response 400** if `chainId` not in `{43114, 56}` or if the user has no `smart_account_address` for that chain.

**Response 500** if RPC read fails — FE shows "Could not load balance, retry".

## 4. Files to touch

### New

- `be/src/use-cases/interface/output/wallet/withdrawPreview.types.ts` — the `WithdrawPreview` DTO above.
- `be/src/use-cases/implementations/walletWithdraw.usecase.ts` — single function `getWithdrawPreview({ userId, chainId }) => WithdrawPreview`. Reads the user's `smart_account_address` and `eoa_address` from `user_profiles`; reads `chainConfig[chainId].usdcEnvKey` → resolves env → that's `usdc.address`; calls `publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [scaAddress] })`.
- `be/src/adapters/implementations/input/http/routes/wallet.ts` — registers `GET /wallet/withdraw/preview`. Mirror auth wiring from the closest existing route (e.g. `/delegation/grant` route).

### Modified

- `be/src/adapters/implementations/input/http/router.ts` (or wherever route registration lives) — register the new route.
- `be/STATUS.md` — add a "Wallet withdraw" section under endpoints, noting that `/wallet/withdraw/preview` is read-only and the actual sweep is FE-driven via sudo client.

### Untouched (explicitly)

- `signingRequest.usecase.ts`, `delegation/*`, `Erc20SpendMessage` — sweep is sudo-signed, **never** goes through `/delegation/grant` or the off-chain limit checker. If we ever route it through those, it'd reject (sweep amount > granted limit), defeating the rescue purpose.
- DB schema — no migration. `smart_account_address` and `eoa_address` already exist.
- Pimlico / paymaster wiring — gas sponsorship already covers any UserOp from the SCA via the existing sponsorship policy. No new policy needed.

## 5. USDC decimals — where the constant lives

Per CLAUDE.md, no hardcoded values. The chain-specific USDC address comes from `chainConfig[chainId].usdcEnvKey` → `process.env[...]`. **Decimals**, however, are not in `chainConfig` today.

Choice for v1: hardcode `decimals: 6` in `walletWithdraw.usecase.ts` with a comment that USDC on Avax (43114) and BSC (56) — both 6 — is the only supported set. If we widen to USDT, DAI, or non-6-decimal tokens, lift this into `chainConfig` as `tokens: { usdc: { envKey, decimals }, ... }` at that time, not pre-emptively.

This is consistent with the existing `chainConfig` structure where decimals appear only inside `yield.stablecoins[]`. v1 sweep is USDC-only, so a local constant is honest.

## 6. Logging (per CLAUDE.md)

```ts
const log = createLogger("walletWithdraw");

log.info({ userId, chainId, step: "started" }, "withdraw-preview requested");
log.debug({ userId, chainId, scaAddress }, "reading USDC balance");
log.info(
  { userId, chainId, step: "succeeded", durationMs },
  "withdraw-preview ready",
);
log.error({ err, userId, chainId }, "withdraw-preview failed");
```

Never log balance amounts, addresses are fine (public). Never log the Privy token (already enforced by existing middleware).

## 7. Test plan

- Unit: `getWithdrawPreview` with mocked public client — happy path returns `balanceRaw` as decimal string; bad chainId throws; missing user profile throws.
- Integration: hit endpoint with a known testnet user (Fuji is supported by `chainConfig`; if Fuji ever gets `usdcEnvKey: 'FUJI_USDC'` populated, smoke-test there). Otherwise mainnet smoke with a low-balance dev account.
- No e2e here — the sweep itself is FE-tested.

## 8. Out of scope (track separately)

- Multi-asset sweep (native AVAX/BNB, USDT, etc.) — defer until v2; would require either (a) a per-chain token list in `chainConfig` or (b) a portfolio-walking endpoint. v1 commits only to USDC.
- A locking mechanism that prevents the agent from spending USDC mid-sweep. The race is small (single-block) and the worst case is one of the two transfers reverts; FE will retry. Add only if observed in prod.
- Telegram-side notification when a sweep lands. Reuse existing tx-hash notification path if it already covers ERC-20 transfers from the SCA; no new code.

## 9. Cutover

1. Land BE endpoint behind nothing — read-only, safe to deploy.
2. FE plan (separate doc) consumes the endpoint.
3. Monitor `/wallet/withdraw/preview` request rate; if usage is non-trivial, that's the signal to add a generic multi-asset version.
