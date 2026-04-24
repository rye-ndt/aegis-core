# Scaling Phase 3 — Part 1: RPC fallback URLs

> Prerequisites: Phase 2 shipped. Observability not required, but helpful.
> Behavior change: **none** on the happy path. On primary-RPC failure, request falls over to secondaries transparently.
> Expected lift: eliminates a full-service outage class. At 200 users, a 30-second RPC blip on a single-RPC system stalls every in-flight request; with fallbacks, the same blip is invisible.

## Why

`src/helpers/chainConfig.ts:25` defines `defaultRpcUrl: string` — **one** URL per chain. Consumers at:

- `src/adapters/implementations/output/blockchain/viemClient.ts:34` — `http(params.rpcUrl, { timeout: 10_000 })`
- `src/adapters/implementations/output/blockchain/zerodevExecutor.ts:26` — `http(rpcUrl)`
- `src/adapters/implementations/output/yield/aaveV3Adapter.ts:117` — `http(rpcUrl, { timeout: 10_000 })`

All three use viem's `http()` transport with one URL. If the URL rate-limits or 5xx's, every on-chain read fails until it recovers. At 10 users this is painful; at 200 users it's an outage.

viem ships `fallback([http(a), http(b)])` for exactly this. We extend `ChainEntry.defaultRpcUrl` to `defaultRpcUrls: string[]` and rebuild the transport with `fallback`.

## Step 1.1 — Extend `ChainEntry` to support multiple RPCs

Edit `src/helpers/chainConfig.ts`.

Change the interface:

```ts
interface ChainEntry {
  chain: Chain;
  nativeSymbol: string;
  name: string;
  /** Ordered list of RPC URLs. First is primary; subsequent are fallbacks. */
  defaultRpcUrls: string[];
  privyNetwork: string;
  aliases: string[];
  relayEnabled: boolean;
  yield?: YieldChainConfig;
}
```

Update every `CHAIN_REGISTRY` entry. For each chain, replace:

```ts
defaultRpcUrl: "https://api.avax.network/ext/bc/C/rpc",
```

with:

```ts
defaultRpcUrls: [
  "https://api.avax.network/ext/bc/C/rpc",
  "https://avalanche-c-chain-rpc.publicnode.com",
  "https://rpc.ankr.com/avalanche",
],
```

Suggested fallback URLs per chain (verify reachability before merging; `curl <url> -X POST -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'`):

| Chain | Primary | Fallbacks |
| --- | --- | --- |
| Avalanche Fuji (43113) | `https://api.avax-test.network/ext/bc/C/rpc` | `https://avalanche-fuji-c-chain-rpc.publicnode.com`, `https://rpc.ankr.com/avalanche_fuji` |
| Avalanche (43114) | `https://api.avax.network/ext/bc/C/rpc` | `https://avalanche-c-chain-rpc.publicnode.com`, `https://rpc.ankr.com/avalanche` |
| Ethereum (1) | `https://cloudflare-eth.com` | `https://ethereum-rpc.publicnode.com`, `https://rpc.ankr.com/eth` |
| Base (8453) | `https://mainnet.base.org` | `https://base-rpc.publicnode.com`, `https://base.llamarpc.com` |
| Polygon (137) | `https://polygon-rpc.com` | `https://polygon-bor-rpc.publicnode.com`, `https://rpc.ankr.com/polygon` |
| Arbitrum (42161) | `https://arb1.arbitrum.io/rpc` | `https://arbitrum-one-rpc.publicnode.com`, `https://rpc.ankr.com/arbitrum` |
| Optimism (10) | `https://mainnet.optimism.io` | `https://optimism-rpc.publicnode.com`, `https://rpc.ankr.com/optimism` |

Replace `getChainRpcUrl` (around line 122):

```ts
export function getChainRpcUrls(chainId: number): string[] {
  return CHAIN_REGISTRY[chainId]?.defaultRpcUrls ?? [];
}
```

Keep a temporary back-compat shim so unchanged callers keep working:

```ts
/** @deprecated use getChainRpcUrls */
export function getChainRpcUrl(chainId: number): string {
  return getChainRpcUrls(chainId)[0] ?? "";
}
```

Update the `CHAIN_CONFIG` export at the bottom (line 160-168):

```ts
const envOverride = process.env.RPC_URL;
const envFallback = process.env.RPC_URL_FALLBACKS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

const rpcUrls = envOverride
  ? [envOverride, ...envFallback]
  : entry.defaultRpcUrls;

export const CHAIN_CONFIG = {
  chainId,
  chain: entry.chain,
  nativeSymbol: entry.nativeSymbol,
  name: entry.name,
  /** @deprecated Single URL retained for legacy callers. Use `rpcUrls`. */
  rpcUrl: rpcUrls[0],
  rpcUrls,
  bundlerUrl: process.env.AVAX_BUNDLER_URL,
  paymasterUrl: process.env.AVAX_PAYMASTER_URL,
} as const;
```

`RPC_URL` env keeps its role as the override for the primary (single-URL deploys keep working). `RPC_URL_FALLBACKS` is a new comma-separated list.

## Step 1.2 — Use viem `fallback` transport at consumers

Three files. Each replaces a single-URL `http(...)` with `fallback([http(url, opts), ...])`.

### 1.2.1 — `src/adapters/implementations/output/blockchain/viemClient.ts`

At line 1, expand the viem import:

```ts
import { createPublicClient, fallback, http, /* existing imports */ } from "viem";
```

At line 34, replace:

```ts
const transport = http(params.rpcUrl, { timeout: 10_000 });
```

with:

```ts
const urls = params.rpcUrls && params.rpcUrls.length > 0
  ? params.rpcUrls
  : [params.rpcUrl];
const transport = fallback(
  urls.map((url) => http(url, { timeout: 10_000 })),
  { rank: false, retryCount: 1 },
);
```

Extend the `params` type in the same file to accept either `rpcUrl: string` (legacy) or `rpcUrls: string[]`. Tip: make `rpcUrls` optional, keep `rpcUrl` required, derive `urls` as above. That avoids touching every caller now.

### 1.2.2 — `src/adapters/implementations/output/blockchain/zerodevExecutor.ts`

At line 1, add `fallback`:
```ts
import { createPublicClient, fallback, http, /* existing */ } from "viem";
```

At line 26, change:
```ts
this.publicClient = createPublicClient({ transport: http(rpcUrl), chain });
```

to:
```ts
const urls = (rpcUrls && rpcUrls.length > 0) ? rpcUrls : [rpcUrl];
this.publicClient = createPublicClient({
  transport: fallback(urls.map((u) => http(u)), { retryCount: 1 }),
  chain,
});
```

Update the constructor signature to accept `rpcUrls?: string[]` (optional, for compatibility). Callers in the DI layer can be updated in the next commit.

### 1.2.3 — `src/adapters/implementations/output/yield/aaveV3Adapter.ts`

Same pattern:
```ts
import { createPublicClient, fallback, http, maxUint256, encodeFunctionData, type Address } from "viem";
```

Line 117 replacement:
```ts
const urls = (rpcUrls && rpcUrls.length > 0) ? rpcUrls : [rpcUrl];
this.client = createPublicClient({
  chain,
  transport: fallback(
    urls.map((u) => http(u, { timeout: 10_000 })),
    { retryCount: 1 },
  ),
});
```

Pass `rpcUrls` through the constructor.

## Step 1.3 — Thread `rpcUrls` through DI

Edit `src/adapters/inject/assistant.di.ts`. Find every call site that constructs a `PublicClient`-using adapter and pass the new field. Grep for `CHAIN_CONFIG.rpcUrl` to locate them; update each to also pass `CHAIN_CONFIG.rpcUrls`. The constructors accept the optional new field without breaking.

## Step 1.4 — Env in `.env.example`

Append to `# Scaling — Phase 3`:

```
# Optional. Comma-separated list of secondary RPC URLs tried on primary failure.
# RPC_URL remains the primary. When RPC_URL is unset, defaults from chainConfig.ts apply.
RPC_URL_FALLBACKS=
```

## How to verify locally

1. `docker compose up -d postgres redis` and `npm run dev`.
2. Normal traffic: portfolio reads, yield scans — unchanged.
3. **Simulate primary outage** without touching remote URLs:
   - Start the dev process pointing to a known-bad primary:
     ```
     RPC_URL=https://127.0.0.1:1/dead \
     RPC_URL_FALLBACKS=https://api.avax-test.network/ext/bc/C/rpc \
     npm run dev
     ```
   - Hit `/portfolio` or any RPC-using endpoint. It must still return a result, just 10–100 ms slower (one failed attempt before fallback).
4. Reverse: bad fallback, good primary → still works, fallback unused.
5. Both bad → request errors (expected; no silent success).
6. `npx tsc --noEmit` — clean.

Viem's `fallback` does NOT automatically ladder through every URL on every request — it sticks with the last known-good. On failure it advances. That matches our goal (minimize latency when primary is healthy).

## Rollback

Revert the three consumer files and the chainConfig change. The back-compat shim means no cascading revert.

## Acceptance

- Compile clean.
- With a bad `RPC_URL` and a good fallback in env, the app still reads chain data.
- Logs show the fallback being used (viem's `onFallbackTransport` hook can be added in a follow-up for telemetry; not required for the fix).
- No change in behavior when all RPCs are healthy.

## Record in STATUS.md

```
- 2026-04-24 — `ChainEntry.defaultRpcUrls` is now `string[]` (ordered primary →
  fallbacks). All viem PublicClients use `fallback([http(u1), http(u2), ...])`
  with `retryCount: 1`. Env: `RPC_URL_FALLBACKS` (comma-separated) supplements
  `RPC_URL` at runtime. `getChainRpcUrl` deprecated; prefer `getChainRpcUrls`.
```
