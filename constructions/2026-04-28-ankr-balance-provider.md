# Implementation plan: Ankr-backed token balance provider

**Status:** Planned
**Author / date:** 2026-04-28
**Scope:** Backend only (`be/src/`). Frontend response schema is preserved; no FE change required for this phase.

---

## 1. Goal

Replace the per-token RPC loop in `PortfolioUseCaseImpl.getPortfolio` with a **single Ankr Advanced API call** that returns the user's entire ERC-20 + native balance set for the configured chain — already filtered to non-zero holdings, with USD value attached.

This fixes the "panel shows tokens worth $0" bug at its root: the registry-driven loop returns an entry per registered token (zero-balance included); Ankr returns only assets the wallet actually holds.

**Non-goals**
- Changing the FE `/portfolio` response schema (keep `{ smartAccountAddress, balances: [{ symbol, address, decimals, balance }] }`). USD value is added as an **optional** field consumers can opt into later.
- Replacing on-chain reads in the **yield** path (`aaveV3Adapter`, `chainReader`) — those stay RPC-based since they query specific contract state Ankr does not expose.
- Removing the `tokenRegistry` table — still used by `listTokens(chainId)` (resolver / send flows). Only `getPortfolio` stops depending on it.

---

## 2. Why Ankr (vs. alternatives)

| Provider | Single call covers native+ERC20+USD? | Multi-chain in `chainConfig.ts` covered? | Free tier without card |
|---|---|---|---|
| **Ankr `ankr_getAccountBalance`** | Yes | avalanche, eth, base, polygon, arbitrum, optimism — all covered | Yes (public tier rate-limited; key adds quota) |
| Moralis | Yes (separate calls for native vs. ERC20) | Yes | Yes |
| Alchemy | ERC20 only, no prices | Yes | Yes |

Ankr returns the desired schema in one HTTP call across all production chains we ship today. Fuji (43113) is **not** supported by Ankr's balance API — handled in §6.

---

## 3. Architectural placement (hexagonal)

Add a new **output port** so the adapter is swappable and the use case stays infra-agnostic per `CLAUDE.md`.

```
use-cases/interface/output/blockchain/
  balanceProvider.interface.ts        (NEW — port)

adapters/implementations/output/balance/
  ankrBalanceProvider.ts              (NEW — adapter)
  rpcBalanceProvider.ts               (NEW — fallback adapter wrapping existing chainReader+tokenRegistry loop)
```

`PortfolioUseCaseImpl` depends only on `IBalanceProvider`. `chainReader` and `tokenRegistryService` are removed from its constructor — they are now adapter implementation details.

---

## 4. Port contract

`be/src/use-cases/interface/output/blockchain/balanceProvider.interface.ts`

```ts
export type ProviderBalance = {
  symbol: string;
  address: string;        // "0x0000…0000" sentinel for native
  decimals: number;
  balance: string;        // human-formatted, fixed decimals (matches existing schema)
  rawBalance: string;     // bigint as string (preserves precision)
  usdValue: number | null;
  isNative: boolean;
};

export interface IBalanceProvider {
  /**
   * Return all non-zero balances (native + ERC20) for `address` on `chainId`.
   * Implementations MUST omit zero-balance entries.
   * Implementations MUST sort by usdValue desc when usdValue is available.
   */
  getBalances(chainId: number, address: `0x${string}`): Promise<ProviderBalance[]>;
}
```

`PortfolioBalance` (use-case input type) gains an optional `usdValue?: number | null` — additive, no FE break.

---

## 5. Ankr adapter

`be/src/adapters/implementations/output/balance/ankrBalanceProvider.ts`

### 5.1 Endpoint

`POST https://rpc.ankr.com/multichain/<ANKR_API_KEY>` (or public `https://rpc.ankr.com/multichain` with lower quota).

Body:
```json
{
  "jsonrpc": "2.0",
  "method": "ankr_getAccountBalance",
  "params": {
    "blockchain": ["avalanche"],
    "walletAddress": "0x…",
    "onlyWhitelisted": true,
    "nativeFirst": true
  },
  "id": 1
}
```

Response item shape (relevant fields):
```
{ blockchain, tokenName, tokenSymbol, tokenDecimals, tokenType ("NATIVE"|"ERC20"),
  contractAddress?, holderAddress, balance, balanceRawInteger, balanceUsd, tokenPrice }
```

### 5.2 Chain ID → Ankr `blockchain` slug

New helper in `chainConfig.ts`:

```ts
ankrBlockchain?: string   // added to ChainEntry
```

Mapping:
- 43114 → `"avalanche"`
- 1     → `"eth"`
- 8453  → `"base"`
- 137   → `"polygon"`
- 42161 → `"arbitrum"`
- 10   → `"optimism"`
- 43113 → **null** (Fuji unsupported — adapter must throw `UnsupportedChainError`)

Helper exported: `getAnkrBlockchain(chainId): string | null`. No chain-specific mapping anywhere else.

### 5.3 Mapping Ankr → `ProviderBalance`

```ts
{
  symbol: tokenSymbol,
  address: contractAddress ?? NATIVE_ADDRESS_SENTINEL,
  decimals: tokenDecimals,
  balance: parseFloat(balance).toFixed(6),      // matches current "(Number(raw)/10**dec).toFixed(6)" format
  rawBalance: balanceRawInteger,
  usdValue: balanceUsd != null ? parseFloat(balanceUsd) : null,
  isNative: tokenType === "NATIVE",
}
```

Sort by `usdValue` desc; null `usdValue` items pinned to bottom.

### 5.4 Networking, timeouts, retries

- Use global `fetch` with `AbortController`, timeout 8s.
- One retry on 5xx / network error, exponential backoff (200ms → 800ms).
- On non-2xx after retry: throw — caller (use case) decides fallback.
- No caching at this layer (caching is the use case's concern; see §7).

### 5.5 Logging (per `CLAUDE.md`)

`const log = createLogger('AnkrBalanceProvider')`

```ts
log.debug({ chainId, address, blockchain }, "ankr-request");
log.debug({ choice: 'miss' /* always — no cache here */ }, "balance-fetch");
log.warn({ status, url, attempt }, "ankr-fetch-retry");
log.error({ err, chainId }, "ankr-fetch-failed");
log.info({ chainId, count: result.length, durationMs }, "balances-fetched");
```

Never log the API key. Truncate address in `debug` events if you prefer (`address.slice(0,6)+'…'+address.slice(-4)`).

### 5.6 Env

Add to `be/src/helpers/env/`:
- `ANKR_API_KEY` — optional. When unset, adapter uses the public endpoint (rate-limited; surface a `warn` once at startup).

Document in `.env.example`.

---

## 6. Use case rewrite

`be/src/use-cases/implementations/portfolio.usecase.ts`

```ts
export class PortfolioUseCaseImpl implements IPortfolioUseCase {
  constructor(
    private readonly userProfileDB: IUserProfileDB,
    private readonly tokenRegistryService: ITokenRegistryService, // kept for listTokens()
    private readonly balanceProvider: IBalanceProvider,
    private readonly fallbackProvider: IBalanceProvider,          // RPC-based, used for Fuji + on Ankr failure
    private readonly chainId: number,
  ) {}

  async getPortfolio(userId: string): Promise<PortfolioResult | null> {
    const profile = await this.userProfileDB.findByUserId(userId);
    if (!profile?.smartAccountAddress) return null;
    const sca = profile.smartAccountAddress as `0x${string}`;

    let balances: ProviderBalance[];
    try {
      balances = await this.balanceProvider.getBalances(this.chainId, sca);
    } catch (err) {
      log.warn({ err, chainId: this.chainId, step: 'fallback' }, "primary-provider-failed");
      balances = await this.fallbackProvider.getBalances(this.chainId, sca);
    }

    return {
      smartAccountAddress: profile.smartAccountAddress,
      balances: balances.map(b => ({
        symbol: b.symbol,
        address: b.address,
        decimals: b.decimals,
        balance: b.balance,
        usdValue: b.usdValue,           // additive
      })),
    };
  }
  // listTokens(), getWalletInfo() unchanged.
}
```

`getPortfolio.tool.ts` (LLM tool) takes the same constructor swap so the agent sees only held tokens.

---

## 7. Caching

Add a thin in-memory cache keyed by `${chainId}:${address}` with 30s TTL inside the use case (or a dedicated `CachedBalanceProvider` decorator — preferred for testability). Justification: `/portfolio` is polled by the FE on tab focus; Ankr free tier has request limits.

Logging:
```ts
log.debug({ choice: hit ? 'hit' : 'miss', chainId, requestId }, "balance-cache");
```

Invalidation: time-based only for v1. Future: invalidate on confirmed send/swap tx (out of scope here).

---

## 8. RPC fallback adapter

`rpcBalanceProvider.ts` wraps the **existing** `tokenRegistryService.listByChain` + `chainReader` loop, but with the bug fix already discussed:

- Filter `rawBalance > 0n` before returning.
- Use viem `multicall` for batch (`chainReader` already exposes a viem client; add `getErc20BalancesBatch` if not present).
- No USD value (returns `usdValue: null`).

This preserves a working code path for Fuji (43113) and any future chain not yet on Ankr, plus serves as resilience when Ankr is down.

---

## 9. DI wiring

`be/src/adapters/inject/assistant.di.ts`:

```ts
getBalanceProvider(): IBalanceProvider {
  if (!this._balanceProvider) {
    const ankr = new AnkrBalanceProvider({ apiKey: process.env.ANKR_API_KEY });
    const rpc  = new RpcBalanceProvider(this.getViemClient(), this.getTokenRegistryService());
    // Use RPC directly when chain has no Ankr mapping (e.g. Fuji)
    this._balanceProvider = getAnkrBlockchain(this.getChainId()) ? new CachedBalanceProvider(ankr, 30_000) : rpc;
    this._fallbackProvider = rpc;
  }
  return this._balanceProvider;
}

getPortfolioUseCase() {
  // pass balanceProvider + fallbackProvider instead of viemClient
}
```

Same wiring change for `GetPortfolioTool` registration (line 340).

---

## 10. File-level checklist

| Action | Path |
|---|---|
| NEW | `be/src/use-cases/interface/output/blockchain/balanceProvider.interface.ts` |
| NEW | `be/src/adapters/implementations/output/balance/ankrBalanceProvider.ts` |
| NEW | `be/src/adapters/implementations/output/balance/rpcBalanceProvider.ts` |
| NEW | `be/src/adapters/implementations/output/balance/cachedBalanceProvider.ts` |
| EDIT | `be/src/helpers/chainConfig.ts` — add `ankrBlockchain` field per chain + `getAnkrBlockchain(chainId)` |
| EDIT | `be/src/use-cases/interface/input/portfolio.interface.ts` — add `usdValue?: number \| null` to `PortfolioBalance` |
| EDIT | `be/src/use-cases/implementations/portfolio.usecase.ts` — swap deps, single-call flow |
| EDIT | `be/src/adapters/implementations/output/tools/getPortfolio.tool.ts` — same swap |
| EDIT | `be/src/adapters/inject/assistant.di.ts` — wire `IBalanceProvider`, update both consumers |
| EDIT | `.env.example` — add `ANKR_API_KEY` |
| EDIT | `be/status.md` — record the new convention (port + adapter pattern, env var, zero-balance filter is now provider-side) |

---

## 11. Test plan

- **Unit**: `AnkrBalanceProvider.getBalances` — mock `fetch`, assert mapping, sort, retry behavior, native handling.
- **Unit**: `CachedBalanceProvider` — TTL hit/miss, error-not-cached.
- **Integration (manual)**: hit `/portfolio` for a known wallet on Avalanche mainnet — verify only USDT/USDC/AVAX appear, USD totals match the explorer.
- **Regression**: `/portfolio` on Fuji still works (RPC fallback path).
- **Tool regression**: `getPortfolio` agent tool returns held-tokens-only.

---

## 12. Rollout

1. Land port + adapters + cached decorator + DI wiring behind a feature flag env var `PORTFOLIO_PROVIDER=ankr|rpc` (default `rpc` for safety).
2. Smoke-test in staging with `PORTFOLIO_PROVIDER=ankr`.
3. Flip default to `ankr` after one day of clean logs (no `primary-provider-failed` warns).
4. Remove the flag in a follow-up once stable.

---

## 13. Open questions

- Do we want USD value surfaced in the FE in the same PR? (Schema is additive; FE just needs to read `usdValue` instead of computing 0.)
- Should `CachedBalanceProvider` be Redis-backed instead of in-memory? Useful only if multiple BE replicas; defer until needed.
- Long-term: is it worth dropping `tokenRegistry` for non-portfolio uses too (resolver, send)? Out of scope here, but Ankr also exposes per-chain token metadata which could replace the table.
