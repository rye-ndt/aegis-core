# Aster tokenized stocks — Backend implementation plan

**Status:** ready to implement
**Date:** 2026-05-04
**Companion plans:**
- High-level: `be/constructions/2026-05-04-aster-stocks-plan.md`
- FE companion: `fe/privy-auth/constructions/2026-05-04-aster-stocks-impl.md`

This document is the step-by-step recipe. It assumes the implementer has read the high-level plan but otherwise gives them everything: file paths, signatures, code skeletons, test gates. **Do not deviate without updating this file.**

The work is split into three phases. Each phase ends in a verifiable demo. Ship phases independently — no flag.

---

## Glossary (copy-paste exact strings)

- **Diamond (BSC)**: `0x1b6F2d3844C6ae7D56ceb3C3643b9060ba28FEb0`
- **PairsManagerFacet (BSC)**: `0xA32b528D70D1d5bA93a17D2697Efe5D17F1A6F8d`
- **TradingReaderFacet (BSC)**: `0x28dE81Bc5B6164d8522ad32AD7D139A21fa1E3b4`
- **LimitOrderFacet (BSC)**: `0xEfCfb55051BE95294261770d1cBaEa0aa45076e4`
- **BrokerManagerFacet (BSC)**: `0x41a5814536cDB3cd096802C0fd610a2158577044`
- **USDC.bsc**: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` (Binance-Peg USD Coin, **18 decimals on BSC**)
- **`pairsV4()` selector**: `0xf6d94582`
- **`getPairByBaseV4(address)` selector**: `0x9bd39764`
- **`getPositionsV2(address)` selector**: `0x...` (resolve via verified ABI at impl time)
- **Stock pair indices** (last byte of synthetic `pairBase` address): AAPL=0x30, AMZN=0x31, TSLA=0x32, NVDA=0x34, GOOG=0x35, META=0x36 — **these are last bytes only, not full addresses**. Resolve full pairBase via `pairsV4()` decode at boot.

---

# Phase 1 — Read-only foundation

**Demo:** at end of phase 1, `/stocks/pairs` HTTP route returns the live mapping (6 stock pairs verified against the BSC Diamond at boot). Nothing user-signing-related yet, no quote/position routes yet.

**Scope changes from review (fix #10, #11) and from impl-time discovery:**
- **Positions read path is deferred to Phase 2** (fix #11). The `getPositionsV2` ABI struct is not yet finalised, so shipping `/stocks/positions` or `get_stock_positions` agent tool now would only "work" trivially for users with zero positions. We move the positions provider, route, and agent tool entirely to Phase 2.
- **No agent tools in Phase 1** (fix #10). Shipping `get_stock_quote` to the agent without an execution capability would let the agent imply it can buy. Tools land in Phase 2 alongside the buy/short capability.
- **`/stocks/quote` is deferred to Phase 2** *(impl-time finding, 2026-05-04)*. The `getMarketInfos` ABI struct decode against the live Diamond produced sentinel values for some symbols (TSLA returned `2^256-1`, four others returned `100`, AMZN returned `0`). Without verified BscScan source for the reader facet, the mark price is unreliable. Same fix #11 logic — defer the route until Phase 2 confirms the struct via verified source. The `AsterPriceOracle` files ship as scaffolding (compiled, not exposed on any route) so Phase 2 only needs ABI tweaks.

## P1.1 — Add BSC to chain registry

**File:** `be/src/helpers/chainConfig.ts`

1. Add chain id `56` entry to `CHAIN_REGISTRY`:
   ```ts
   56: {
     chain: bsc,                    // import from "viem/chains"
     nativeSymbol: "BNB",
     name: "BNB Chain",
     defaultRpcUrls: [
       "https://bsc.publicnode.com",
       "https://bsc-rpc.publicnode.com",
       "https://binance.llamarpc.com",
     ],
     privyNetwork: "bnb-smart-chain", // confirm exact slug with Privy team; placeholder
     aliases: ["bsc", "bnb", "bnb-chain", "binance-smart-chain"],
     // INTENTIONALLY false in phase 1. Flip to true in phase 2 alongside the
     // `/swap to bsc` UX validation. See P1.1.audit below.
     relayEnabled: false,
     usdcEnvKey: "BSC_USDC",
     ankrBlockchain: "bsc",
     // no `yield` block — Aave V3 not deployed on BSC for stables in this scope
   },
   ```
2. Add `import { bsc } from "viem/chains";` at the top.
3. `RELAY_SUPPORTED_CHAIN_IDS` is computed from the registry — phase 1 ships with BSC excluded (relayEnabled: false). Phase 2 flips this on.
4. Verify `getNativeTokenInfo(56)` returns `{ symbol: "BNB", ..., decimals: 18, address: NATIVE_PSEUDO_ADDRESS }`.

**Verification:**
```bash
node -e "console.log(require('./dist/be/src/helpers/chainConfig').CHAIN_REGISTRY[56])"
```

### P1.1.audit — fan-out audit (REQUIRED before phase 1 merge)

Adding chain 56 to `CHAIN_REGISTRY` may silently change behaviour anywhere that iterates the registry. Audit these call sites and document findings in the PR description:

- **`/portfolio` HTTP route + `getPortfolio.tool.ts`** — confirm they read a single home chain (`CHAIN_CONFIG.chainId`) and do **not** fan out across all configured chains. If they fan out, BSC will be queried per request and Ankr quota doubles. If fan-out is found, gate it on a per-chain allow-list before phase 1 ships.
- **`AnkrBalanceProvider` / `AnkrTransferHistoryProvider`** — confirm callers pass an explicit `chainId`; the providers themselves only respond when asked. The risk lives upstream (in `getPortfolio` / `/transfers`), not in the providers.
- **`getEnabledYieldChains()`** — already gated by `YIELD_ENABLED_CHAIN_IDS` env, defaults to `43114`. Adding 56 to the registry without `yield: { … }` block keeps it out — verified.
- **`RELAY_SUPPORTED_CHAIN_IDS`** — `relayEnabled: false` in phase 1 keeps `/swap … to bsc` rejected by `swapCapability.finishCompileOrResolve`'s gate. No phase-1 surprise.
- **`token_crawler` / `PangolinTokenCrawler`** — Avalanche-only by env design; verify it doesn't iterate the registry.

Acceptance: PR description must include a one-line "audit OK" note per bullet, or a fix linked.

## P1.2 — Add USDC.bsc env var

**File:** `be/.env.example` (and prod secret manager)

```
BSC_USDC=0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d
```

## P1.3 — Seed USDC.bsc into `token_registry`

**File:** `be/drizzle/seed/tokenRegistry.ts`

Add a row for USDC on chain 56. **Critical: 18 decimals, not 6.**

```ts
{
  symbol: "USDC",
  name: "Binance-Peg USD Coin",
  address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  decimals: 18,
  chainId: 56,
  // ... whatever standard fields existing rows use
},
```

Do **not** add native BNB rows — they are synthesized via `getNativeTokenInfo(56)` per the 2026-05-04 native-synthesis convention.

Run `npm run db:generate && npm run db:migrate` if any schema-affecting changes; pure data seed = re-run the seed script.

## P1.4 — Aster env reader

**New file:** `be/src/helpers/env/asterEnv.ts`

```ts
import { createLogger } from "../observability/logger";

const log = createLogger("asterEnv");

export const ASTER_ENV = {
  diamondAddressBsc: (
    process.env.ASTER_DIAMOND_ADDRESS_BSC ??
    "0x1b6F2d3844C6ae7D56ceb3C3643b9060ba28FEb0"
  ).toLowerCase() as `0x${string}`,
  brokerId: BigInt(process.env.ASTER_BROKER_ID ?? "0"),
  positionsTtlSec: Number(process.env.ASTER_POSITIONS_TTL_SEC ?? 60),
  priceTtlSec: Number(process.env.ASTER_PRICE_TTL_SEC ?? 15),
  recoveryEnabled: (process.env.STOCK_RECOVERY_ENABLED ?? "true") === "true",
  bscRpcUrl: process.env.BSC_RPC_URL,                   // optional override
} as const;

if (!/^0x[0-9a-fA-F]{40}$/.test(ASTER_ENV.diamondAddressBsc)) {
  log.error({ value: ASTER_ENV.diamondAddressBsc }, "ASTER_DIAMOND_ADDRESS_BSC malformed");
  throw new Error("ASTER_DIAMOND_ADDRESS_BSC must be a 0x-prefixed 20-byte hex string");
}
```

## P1.5 — Aster ABI fragments

**New file:** `be/src/adapters/implementations/output/aster/asterAbi.ts`

Pull fragments from BscScan's verified source for the named facets. Only include selectors we actually use. Skeleton:

```ts
import type { Abi } from "viem";

// PairsManagerFacet
export const ASTER_PAIRS_ABI = [
  {
    name: "pairsV4",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [/* the verified output struct — populate from BscScan */],
  },
  {
    name: "getPairByBaseV4",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "base", type: "address" }],
    outputs: [/* PairView struct */],
  },
] as const satisfies Abi;

// TradingReaderFacet
export const ASTER_READER_ABI = [
  {
    name: "getPositionsV2",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [/* Position[] struct from verified source */],
  },
  {
    name: "getMarketInfos",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "pairBases", type: "address[]" }],
    outputs: [/* MarketInfo[] */],
  },
] as const satisfies Abi;

// TradingPortalFacet (root Diamond)
export const ASTER_PORTAL_ABI = [
  {
    name: "openMarketTrade",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{
      name: "data",
      type: "tuple",
      components: [
        { name: "pairBase",   type: "address" },
        { name: "isLong",     type: "bool" },
        { name: "tokenIn",    type: "address" },
        { name: "amountIn",   type: "uint256" },
        { name: "qty",        type: "uint256" },
        { name: "price",      type: "uint256" },
        { name: "stopLoss",   type: "uint256" },
        { name: "takeProfit", type: "uint256" },
        { name: "broker",     type: "uint256" },
      ],
    }],
    outputs: [{ name: "tradeHash", type: "bytes32" }],
  },
  {
    name: "closeTrade",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "tradeHash", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "updateTradeTpAndSl",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tradeHash",     type: "bytes32" },
      { name: "stopLossPrice", type: "uint256" },
      { name: "takeProfitPrice", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;
```

**Action item for impl:** open https://bscscan.com/address/0xA32b528D70D1d5bA93a17D2697Efe5D17F1A6F8d#code, copy the `pairsV4` and `getPairByBaseV4` output structs verbatim into `ASTER_PAIRS_ABI`. Same for `0x28dE81Bc5B6164d8522ad32AD7D139A21fa1E3b4` (TradingReaderFacet). The Diamond proxy at `0x1b6F…FEb0` itself doesn't need verification — calls are routed through the facets.

## P1.6 — New ports (interfaces only — no implementations yet)

**New dirs:**
- `be/src/use-cases/interface/output/stocks/` — output ports (broker, positions, oracle, pair registry, cross-chain swap planner).
- `be/src/use-cases/interface/input/stock.interface.ts` — input port (`IStockUseCase`) consumed by the capability (Phase 2; interface lives here from the start so types are stable).

**Fix #7 — broker port carries balance reads.** The use-case must not hold a `venuePublicClient`. Add `getCollateralBalance(trader): Promise<bigint>` to `IStockBrokerProvider` so the recovery flow can ask the adapter for the SCA's venue-USDC balance without leaking adapter concerns into the domain.

**Fix #8 — cross-chain swap planning has its own port.** The use-case must not call the Relay client directly (would mirror the same boundary leak we already fixed in `swapCapability`). Define `ICrossChainSwapPlanner` here in Phase 1 (interface only) so that the Phase 2 use-case takes it as a dep. The Phase 2 implementation will be a thin wrapper over the existing relay client.

Create five interface files. **No implementation logic in this step** — just the contracts.

**`use-cases/interface/input/stock.interface.ts`:**
```ts
import type { StockPosition } from "../output/stocks/stockPositionsProvider.interface";

export interface BuyPlanInput { userId: string; symbol: string; amountUsd: string; isShort?: boolean; }
export interface ClosePlanInput { userId: string; tradeHash: `0x${string}`; }
export interface SetExitsPlanInput {
  userId: string; tradeHash: `0x${string}`;
  stopLossUsd?: string; takeProfitUsd?: string;
}
export interface StockExecutionStep {
  label: string;
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  chainId: number;
  spendTokenAddress?: string;
  spendAmountRaw?: string;
}
export interface StockExecutionPlan {
  kind: "buy" | "short" | "close" | "set_exits" | "recovery"; // fix #2: explicit recovery kind
  symbol: string; // for "recovery" with no associated symbol, set to "" (empty string), NEVER "?"
  steps: StockExecutionStep[];
  quoteSummary: string;
}
export type PositionResolution =
  | { kind: "none" }
  | { kind: "one"; position: StockPosition }
  | { kind: "many"; positions: StockPosition[] };

export interface IStockUseCase {
  buildOpenPlan(input: BuyPlanInput): Promise<StockExecutionPlan>;
  buildClosePlan(input: ClosePlanInput): Promise<StockExecutionPlan>;
  buildSetExitsPlan(input: SetExitsPlanInput): Promise<StockExecutionPlan>;
  /** Build a stand-alone return-swap plan for the recovery flow. */
  buildReturnSwapPlan(input: { userId: string }): Promise<StockExecutionPlan | null>;
  listPositions(userId: string): Promise<StockPosition[]>;
  resolvePositionForSymbol(userId: string, symbol: string): Promise<PositionResolution>;
}
```

The four output ports below.

**`stockPair.interface.ts`:**
```ts
export interface IStockPairRegistry {
  /** Resolve a stock symbol like "TSLA" to the on-venue synthetic pairBase address. */
  resolve(symbol: string): `0x${string}` | null;
  /** Return all known symbols (uppercase). Stable order. */
  symbols(): readonly string[];
  /** Verify the in-memory map against the live chain. Throws on mismatch. Called at boot. */
  verifyAgainstChain(): Promise<void>;
}
```

**`stockPriceOracle.interface.ts`:**
```ts
export interface StockMark {
  symbol: string;
  /** Mark price in human-readable USD (e.g. "189.42"). */
  priceUsd: string;
  /** Source-chain timestamp (epoch seconds). */
  asOfEpoch: number;
}
export interface IStockPriceOracle {
  markPrice(symbol: string): Promise<StockMark>;
  markPrices(symbols: readonly string[]): Promise<StockMark[]>;
}
```

**`stockPositionsProvider.interface.ts`:**
```ts
export interface StockPosition {
  tradeHash: `0x${string}`;
  symbol: string;
  side: "long" | "short";
  entryPriceUsd: string;
  markPriceUsd: string;
  collateralUsd: string;
  notionalUsd: string;
  unrealizedPnlUsd: string;
  stopLossUsd: string | null;
  takeProfitUsd: string | null;
  openedAtEpoch: number;
}
export interface IStockPositionsProvider {
  list(traderAddress: `0x${string}`): Promise<StockPosition[]>;
}
```

**`crossChainSwapPlanner.interface.ts`** (new — fix #8):
```ts
export interface CrossChainSwapPlanInput {
  user: `0x${string}`;
  recipient: `0x${string}`;
  fromChainId: number;
  toChainId: number;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  /** Raw amount in `fromToken` decimals. */
  amountRaw: string;
}
export interface CrossChainSwapPlan {
  txs: ReadonlyArray<{ to: `0x${string}`; data: `0x${string}`; value: string }>;
  /** Expected output amount on the destination chain, raw, in `toToken` decimals. */
  expectedOutRaw: string;
}
export interface ICrossChainSwapPlanner {
  plan(input: CrossChainSwapPlanInput): Promise<CrossChainSwapPlan>;
}
```

The Phase 2 implementation lives at `be/src/adapters/implementations/output/stocks/relayCrossChainSwapPlanner.ts` and wraps the existing relay client. Defining the interface in Phase 1 lets the Phase 2 use-case take it as a structural dep without referring to the relay adapter directly.

**`stockBrokerProvider.interface.ts`:**
```ts
export interface UnsignedTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;     // decimal raw, "0" for non-payable
}
export interface OpenPositionParams {
  traderAddress: `0x${string}`;
  symbol: string;
  isLong: boolean;
  collateralAmountRaw: string;    // in collateral-token decimals
  qtyFixed1e10: string;           // pre-computed by use-case
  markPriceFixed1e8: string;      // pre-computed by use-case
  stopLossFixed1e8?: string;
  takeProfitFixed1e8?: string;
}
export interface ClosePositionParams { tradeHash: `0x${string}`; }
export interface SetExitsParams {
  tradeHash: `0x${string}`;
  stopLossFixed1e8: string;     // 0 = unset
  takeProfitFixed1e8: string;   // 0 = unset
}
export interface IStockBrokerProvider {
  readonly venueChainId: number;
  readonly diamondAddress: `0x${string}`;
  readonly collateralToken: { address: `0x${string}`; decimals: number; symbol: string };
  buildOpenPositionTxs(p: OpenPositionParams): Promise<UnsignedTx[]>;   // [maybe approve, openMarketTrade]
  buildClosePositionTxs(p: ClosePositionParams): Promise<UnsignedTx[]>; // [closeTrade]
  buildSetExitsTxs(p: SetExitsParams): Promise<UnsignedTx[]>;            // [updateTradeTpAndSl]
  /** True when trader has approved at least `requiredAmountRaw` on collateralToken to diamondAddress. */
  hasApproval(traderAddress: `0x${string}`, requiredAmountRaw: string): Promise<boolean>;
  /** Read the trader's venue-chain collateral-token balance (raw). Used by the recovery flow. */
  getCollateralBalance(traderAddress: `0x${string}`): Promise<bigint>;
}
```

## P1.7 — Aster adapters (implementations)

**New dir:** `be/src/adapters/implementations/output/aster/`

### `asterDiamond.client.ts`

Single viem `PublicClient` pinned to BSC. Constructed once.

```ts
import { createPublicClient, http, fallback } from "viem";
import { bsc } from "viem/chains";
import { ASTER_ENV } from "../../../../helpers/env/asterEnv";
import { getChainRpcUrls } from "../../../../helpers/chainConfig";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("asterDiamondClient");

export class AsterDiamondClient {
  readonly publicClient;
  readonly diamondAddress = ASTER_ENV.diamondAddressBsc;

  constructor() {
    const urls = ASTER_ENV.bscRpcUrl
      ? [ASTER_ENV.bscRpcUrl, ...getChainRpcUrls(56)]
      : getChainRpcUrls(56);
    this.publicClient = createPublicClient({
      chain: bsc,
      transport: fallback(urls.map((u) => http(u))),
    });
    log.debug({ urlCount: urls.length, diamondAddress: this.diamondAddress }, "client built");
  }
}
```

### `asterPairRegistry.ts`

Hardcoded mapping + boot verification. Hardcoding is intentional — we only ship support for symbols we've explicitly tested.

```ts
import type { IStockPairRegistry } from "../../../../use-cases/interface/output/stocks/stockPair.interface";
import type { AsterDiamondClient } from "./asterDiamond.client";
import { ASTER_PAIRS_ABI } from "./asterAbi";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("asterPairRegistry");

// VERIFIED 2026-05-04 via on-chain pairsV4() decode. Re-verify on every PR
// that touches this file. The full pairBase addresses must be confirmed
// at impl time — the last byte of each is shown here as a sanity hint.
const HARDCODED_PAIRS: Record<string, { pairBase: `0x${string}`; lastByte: number }> = {
  AAPL: { pairBase: "0x...PLACEHOLDER..." as `0x${string}`, lastByte: 0x30 },
  AMZN: { pairBase: "0x...PLACEHOLDER..." as `0x${string}`, lastByte: 0x31 },
  TSLA: { pairBase: "0x...PLACEHOLDER..." as `0x${string}`, lastByte: 0x32 },
  NVDA: { pairBase: "0x...PLACEHOLDER..." as `0x${string}`, lastByte: 0x34 },
  GOOG: { pairBase: "0x...PLACEHOLDER..." as `0x${string}`, lastByte: 0x35 },
  META: { pairBase: "0x...PLACEHOLDER..." as `0x${string}`, lastByte: 0x36 },
};

export class AsterPairRegistry implements IStockPairRegistry {
  constructor(private readonly diamond: AsterDiamondClient) {}

  resolve(symbol: string): `0x${string}` | null {
    return HARDCODED_PAIRS[symbol.trim().toUpperCase()]?.pairBase ?? null;
  }
  symbols(): readonly string[] { return Object.keys(HARDCODED_PAIRS); }

  async verifyAgainstChain(): Promise<void> {
    // 1. Read pairsV4() from the diamond's PairsManagerFacet (calls go through the proxy).
    // 2. Decode with ASTER_PAIRS_ABI.
    // 3. For each hardcoded symbol, assert a match exists with the same pairBase.
    // 4. Throw if any mismatch — fail closed at boot.
    const live = await this.diamond.publicClient.readContract({
      address: this.diamond.diamondAddress,
      abi: ASTER_PAIRS_ABI,
      functionName: "pairsV4",
    });
    // `live` is the decoded array — extract { pairBase, name } per element.
    // Build a Set of live (symbolFromName, pairBaseLowercased) and diff.
    // Pseudocode:
    //   const livePairs = (live as readonly any[]).map(p => ({
    //     symbol: extractSymbol(p.name),   // "AAPL/USD" → "AAPL"
    //     pairBase: (p.pairBase as string).toLowerCase(),
    //   }));
    //   for (const [sym, expected] of Object.entries(HARDCODED_PAIRS)) {
    //     const found = livePairs.find(p => p.symbol === sym);
    //     if (!found) throw new Error(`pair ${sym} missing on-chain`);
    //     if (found.pairBase !== expected.pairBase.toLowerCase())
    //       throw new Error(`pair ${sym} drifted: ${found.pairBase} vs ${expected.pairBase}`);
    //   }
    log.info({ count: Object.keys(HARDCODED_PAIRS).length }, "pair registry verified");
  }
}

function extractSymbol(name: string): string {
  // "AAPL/USD" → "AAPL"
  return name.split("/")[0]?.trim() ?? "";
}
```

### `asterPriceOracle.ts`

```ts
import type { IStockPriceOracle, StockMark } from "../../../../use-cases/interface/output/stocks/stockPriceOracle.interface";
import type { AsterDiamondClient } from "./asterDiamond.client";
import type { IStockPairRegistry } from "../../../../use-cases/interface/output/stocks/stockPair.interface";
import { ASTER_READER_ABI } from "./asterAbi";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("asterPriceOracle");

export class AsterPriceOracle implements IStockPriceOracle {
  constructor(
    private readonly diamond: AsterDiamondClient,
    private readonly pairs: IStockPairRegistry,
  ) {}

  async markPrices(symbols: readonly string[]): Promise<StockMark[]> {
    const bases = symbols.map((s) => this.pairs.resolve(s)).filter(Boolean) as `0x${string}`[];
    const result = await this.diamond.publicClient.readContract({
      address: this.diamond.diamondAddress,
      abi: ASTER_READER_ABI,
      functionName: "getMarketInfos",
      args: [bases],
    });
    // result is MarketInfo[] — extract markPrice per element. Fixed-point 1e8.
    // Pseudocode: format from raw to human via formatUnits(rawPrice, 8).
    log.debug({ count: symbols.length }, "marks fetched");
    const now = newCurrentUTCEpoch();
    return symbols.map((sym, i) => ({
      symbol: sym,
      priceUsd: /* formatUnits((result as any)[i].markPrice, 8) */ "0",
      asOfEpoch: now,
    }));
  }
  async markPrice(symbol: string): Promise<StockMark> {
    const [m] = await this.markPrices([symbol]);
    if (!m) throw new Error(`unknown symbol ${symbol}`);
    return m;
  }
}
```

Add `CachedStockPriceOracle(inner, redis, { ttlSec })` decorator following `CachedBalanceProvider` shape — same file or sibling.

### `asterPositionsProvider.ts` *(deferred to Phase 2 — fix #11)*

The `getPositionsV2` ABI struct must be finalised against the verified BscScan source before this provider can ship. Phase 1 does not include this file, the `IStockPositionsProvider` interface, the `/stocks/positions` HTTP route, the `get_stock_positions` agent tool, or the positions slot in DI. They all move to Phase 2. The skeleton below is preserved for the Phase 2 implementer.



```ts
import type { IStockPositionsProvider, StockPosition } from "../../../../use-cases/interface/output/stocks/stockPositionsProvider.interface";
import type { AsterDiamondClient } from "./asterDiamond.client";
import type { IStockPairRegistry } from "../../../../use-cases/interface/output/stocks/stockPair.interface";
import { ASTER_READER_ABI } from "./asterAbi";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("asterPositionsProvider");

export class AsterPositionsProvider implements IStockPositionsProvider {
  constructor(
    private readonly diamond: AsterDiamondClient,
    private readonly pairs: IStockPairRegistry,
  ) {}

  async list(trader: `0x${string}`): Promise<StockPosition[]> {
    const raw = await this.diamond.publicClient.readContract({
      address: this.diamond.diamondAddress,
      abi: ASTER_READER_ABI,
      functionName: "getPositionsV2",
      args: [trader],
    });
    // Map raw[] to StockPosition[]. Filter to known stock symbols only
    // (the Diamond also returns crypto/forex positions if any).
    const STOCK_SYMBOLS = new Set(this.pairs.symbols());
    log.debug({ trader, count: (raw as readonly any[]).length }, "positions fetched");
    return (raw as readonly any[])
      .map((p) => mapRawPosition(p))
      .filter((p) => STOCK_SYMBOLS.has(p.symbol));
  }
}

function mapRawPosition(_raw: any): StockPosition {
  // TODO at impl time: implement based on verified getPositionsV2 output struct.
  throw new Error("implement after ABI is finalised");
}
```

Add `CachedStockPositionsProvider(inner, redis, userId, { ttlSec })` decorator. **TTL = 60s** (locked). Reuse the `acquireUserSlot` / `acquireGlobalSlot` template only if Aster imposes rate limits — the public BSC RPC is the bottleneck here and we already have viem's `fallback` transport. Cache key: `aster:positions:{userId}`.

### `asterBrokerProvider.ts`

**No hardcoded addresses or decimals** — both come from existing config layers (CLAUDE.md non-negotiable #2):
- Address: `getUsdcAddress(56)` (reads `BSC_USDC` env via `chainConfig`).
- Decimals: looked up via `ITokenRegistryService.findByAddressAndChain(addr, 56)` at construction time and cached on the instance.
- `venueChainId`: 56 is the only constant — and it's the one piece of config the user explicitly locked to this adapter ("the bsc lock is only applied to aster provider"). Acceptable per CLAUDE.md ("chain-specific detail belongs in chainConfig.ts — never inline chain IDs … elsewhere") **only because** this is the chain-config-bound adapter for BSC. Document this exception in `output/aster/status.md`.

```ts
import { encodeFunctionData, erc20Abi } from "viem";
import type { IStockBrokerProvider, OpenPositionParams, ClosePositionParams, SetExitsParams, UnsignedTx } from "../../../../use-cases/interface/output/stocks/stockBrokerProvider.interface";
import type { ITokenRegistryService } from "../../../../use-cases/interface/output/tokenRegistry.interface";
import type { AsterDiamondClient } from "./asterDiamond.client";
import type { IStockPairRegistry } from "../../../../use-cases/interface/output/stocks/stockPair.interface";
import { ASTER_PORTAL_ABI } from "./asterAbi";
import { ASTER_ENV } from "../../../../helpers/env/asterEnv";
import { getUsdcAddress } from "../../../../helpers/chainConfig";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("asterBrokerProvider");

const VENUE_CHAIN_ID = 56;                // BSC. Adapter-bound chain id (see header note).
const MAX_UINT256 = (2n ** 256n - 1n).toString();

export class AsterBrokerProvider implements IStockBrokerProvider {
  readonly venueChainId = VENUE_CHAIN_ID;
  readonly diamondAddress = ASTER_ENV.diamondAddressBsc;
  readonly collateralToken: { address: `0x${string}`; decimals: number; symbol: string };

  static async create(
    diamond: AsterDiamondClient,
    pairs: IStockPairRegistry,
    tokenRegistry: ITokenRegistryService,
  ): Promise<AsterBrokerProvider> {
    const usdcAddr = getUsdcAddress(VENUE_CHAIN_ID);
    if (!usdcAddr) {
      throw new Error("BSC_USDC env not set — required for AsterBrokerProvider");
    }
    const row = await tokenRegistry.findByAddressAndChain(usdcAddr, VENUE_CHAIN_ID);
    if (!row) {
      throw new Error(`USDC.bsc (${usdcAddr}) not found in token_registry — seed it before booting`);
    }
    return new AsterBrokerProvider(diamond, pairs, {
      address: usdcAddr,
      decimals: row.decimals,
      symbol: row.symbol,
    });
  }

  // Private — call AsterBrokerProvider.create(...) instead.
  private constructor(
    private readonly diamond: AsterDiamondClient,
    private readonly pairs: IStockPairRegistry,
    collateralToken: { address: `0x${string}`; decimals: number; symbol: string },
  ) {
    this.collateralToken = collateralToken;
  }

  async hasApproval(trader: `0x${string}`, requiredAmountRaw: string): Promise<boolean> {
    const allowance = await this.diamond.publicClient.readContract({
      address: this.collateralToken.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [trader, this.diamondAddress],
    });
    return BigInt(allowance) >= BigInt(requiredAmountRaw);
  }

  async getCollateralBalance(trader: `0x${string}`): Promise<bigint> {
    const bal = await this.diamond.publicClient.readContract({
      address: this.collateralToken.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader],
    });
    return BigInt(bal as bigint | string);
  }

  async buildOpenPositionTxs(p: OpenPositionParams): Promise<UnsignedTx[]> {
    const pairBase = this.pairs.resolve(p.symbol);
    if (!pairBase) throw new Error(`unknown symbol ${p.symbol}`);

    const txs: UnsignedTx[] = [];

    // Step 1: approve if needed (max-uint to avoid future re-approves).
    if (!(await this.hasApproval(p.traderAddress, p.collateralAmountRaw))) {
      txs.push({
        to: this.collateralToken.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [this.diamondAddress, BigInt(MAX_UINT256)],
        }),
        value: "0",
      });
    }

    // Step 2: openMarketTrade.
    txs.push({
      to: this.diamondAddress,
      data: encodeFunctionData({
        abi: ASTER_PORTAL_ABI,
        functionName: "openMarketTrade",
        args: [{
          pairBase,
          isLong: p.isLong,
          tokenIn: this.collateralToken.address,
          amountIn: BigInt(p.collateralAmountRaw),
          qty: BigInt(p.qtyFixed1e10),
          price: BigInt(p.markPriceFixed1e8),
          stopLoss: BigInt(p.stopLossFixed1e8 ?? "0"),
          takeProfit: BigInt(p.takeProfitFixed1e8 ?? "0"),
          broker: ASTER_ENV.brokerId,
        }],
      }),
      value: "0",
    });
    log.debug({ symbol: p.symbol, isLong: p.isLong, txCount: txs.length }, "open txs built");
    return txs;
  }

  async buildClosePositionTxs(p: ClosePositionParams): Promise<UnsignedTx[]> {
    return [{
      to: this.diamondAddress,
      data: encodeFunctionData({
        abi: ASTER_PORTAL_ABI,
        functionName: "closeTrade",
        args: [p.tradeHash],
      }),
      value: "0",
    }];
  }

  async buildSetExitsTxs(p: SetExitsParams): Promise<UnsignedTx[]> {
    return [{
      to: this.diamondAddress,
      data: encodeFunctionData({
        abi: ASTER_PORTAL_ABI,
        functionName: "updateTradeTpAndSl",
        args: [p.tradeHash, BigInt(p.stopLossFixed1e8), BigInt(p.takeProfitFixed1e8)],
      }),
      value: "0",
    }];
  }
}
```

### `output/aster/status.md`

Create at the end of phase 1; document the boot-time verification, the ABI source, the lockstep convention with the FE, and the locked TTLs.

## P1.8 — DI wiring

**File:** `be/src/adapters/inject/assistant.di.ts`

Add lazy singletons (place near similar `_yieldProtocolRegistry` blocks, around line 880+):

```ts
private _asterDiamondClient: AsterDiamondClient | null = null;
private _stockPairRegistry: IStockPairRegistry | null = null;
private _stockPriceOracle: IStockPriceOracle | null = null;
private _stockBrokerProvider: IStockBrokerProvider | null = null;
private _stockCapabilityDisabled = false; // set true if boot verify fails (fix #9)
// positions provider DEFERRED to phase 2 (fix #11)

getAsterDiamondClient(): AsterDiamondClient {
  if (!this._asterDiamondClient) this._asterDiamondClient = new AsterDiamondClient();
  return this._asterDiamondClient;
}
getStockPairRegistry(): IStockPairRegistry {
  if (!this._stockPairRegistry)
    this._stockPairRegistry = new AsterPairRegistry(this.getAsterDiamondClient());
  return this._stockPairRegistry;
}
getStockPriceOracle(): IStockPriceOracle {
  if (this._stockPriceOracle) return this._stockPriceOracle;
  const inner = new AsterPriceOracle(this.getAsterDiamondClient(), this.getStockPairRegistry());
  const redis = this.getRedis();
  this._stockPriceOracle = redis
    ? new CachedStockPriceOracle(inner, redis, { ttlSec: ASTER_ENV.priceTtlSec })
    : inner;
  return this._stockPriceOracle;
}
async getStockBrokerProvider(): Promise<IStockBrokerProvider> {
  // AsterBrokerProvider.create resolves USDC.bsc decimals from token_registry
  // at boot — no hardcoded decimals. Lazy + memoised on the instance field.
  if (!this._stockBrokerProvider) {
    this._stockBrokerProvider = await AsterBrokerProvider.create(
      this.getAsterDiamondClient(),
      this.getStockPairRegistry(),
      this.getTokenRegistryService(),
    );
  }
  return this._stockBrokerProvider;
}
// positions provider DEFERRED to phase 2 (fix #11)

isStockCapabilityDisabled(): boolean { return this._stockCapabilityDisabled; }

/**
 * Boot-time verification (fix #9 — soft fail).
 * Run once at startup. If verification fails, log error and disable the
 * stock capability — DO NOT crash the entire backend. Non-stock features
 * (send, swap, yield, …) must keep working when Aster is degraded.
 */
async verifyStockCapability(): Promise<void> {
  try {
    await this.getStockPairRegistry().verifyAgainstChain();
  } catch (err) {
    this._stockCapabilityDisabled = true;
    log.error({ err }, "stock capability disabled — boot verification failed");
  }
}
```

**Boot verification call:** the entrypoint files (`telegramCli.ts`, `httpCli.ts`, `workerCli.ts`) must `await assistantDi.verifyStockCapability()` before declaring readiness. Failure no longer crashes the process — it sets a soft-disable flag (fix #9). HTTP route handlers and (in phase 2) the stock capability check `isStockCapabilityDisabled()` and return a friendly "stock trading is temporarily unavailable" response when true.

## P1.9 — Verification script

**New file:** `be/scripts/verify-aster-pairs.ts`

```ts
#!/usr/bin/env -S node --enable-source-maps
import { AsterDiamondClient } from "../src/adapters/implementations/output/aster/asterDiamond.client";
import { AsterPairRegistry } from "../src/adapters/implementations/output/aster/asterPairRegistry";

(async () => {
  const client = new AsterDiamondClient();
  const reg = new AsterPairRegistry(client);
  await reg.verifyAgainstChain();
  console.log("OK — all hardcoded stock pairs verified on-chain");
  process.exit(0);
})().catch((err) => {
  console.error("VERIFY FAILED:", err);
  process.exit(1);
});
```

Add to `package.json`: `"verify:aster": "ts-node scripts/verify-aster-pairs.ts"`. **Must be run before merge.**

## P1.10 — HTTP routes

**File:** `be/src/adapters/implementations/input/http/httpServer.ts`

Add two routes in Phase 1 (positions deferred to Phase 2 per fix #11):

```ts
"GET /stocks/pairs":     (req, res) => this.handleGetStocksPairs(req, res),
"GET /stocks/quote":     (req, res, url) => this.handleGetStocksQuote(req, res, url),
// "GET /stocks/positions" — Phase 2
```

Handlers:

- **`handleGetStocksPairs`** — no auth. Returns `[{ symbol, pairBase }]` from `IStockPairRegistry.symbols()`. Cache header: `Cache-Control: public, max-age=3600`. If `isStockCapabilityDisabled()` is true, return `503` with body `{ error: "stocks_unavailable" }` (fix #9).
- **`handleGetStocksQuote`** — Privy auth. Reads `symbol`, `amountUsd` from query. Calls `IStockPriceOracle.markPrice(symbol)`, computes `qty = amountUsd / mark`, returns `{ symbol, markPriceUsd, qty, collateralUsd: amountUsd }`. No cache header (already cached on the oracle). 503 when disabled.

Update `STATUS.md` HTTP API table.

## P1.11 — Agent tools *(deferred — fix #10)*

Phase 1 ships **no** agent tools. Reason: shipping `get_stock_quote` while no execution capability exists would let the agent quote stocks and confidently imply it can buy them, producing misleading UX. The HTTP `GET /stocks/quote` route is sufficient for FE-side smoke tests; the agent gets stock awareness in Phase 2 simultaneously with the buy/short capability.

Both `get_stock_quote` and `get_stock_positions` move to Phase 2.

## P1.12 — Phase 1 acceptance gate

Before moving to phase 2, all of the following must pass:

- [ ] `npm run verify:aster` exits 0 in CI.
- [ ] Boot of `httpCli` / `telegramCli` / `workerCli` calls `verifyStockCapability()` and proceeds. Forced verification failure (e.g. wrong diamond address) sets the soft-disable flag and the rest of the backend boots cleanly (fix #9).
- [ ] `GET /stocks/pairs` returns 6 entries when healthy; returns 503 with `error: "stocks_unavailable"` when the soft-disable flag is set.
- [ ] No `/stocks/quote` route in Phase 1 (deferred — impl-time finding 2026-05-04).
- [ ] No agent tools registered for stocks (fix #10) — `grep -n "get_stock_" be/src/adapters/implementations/output/systemToolProvider.concrete.ts` returns nothing in phase 1.
- [ ] No `/stocks/positions` route, no `getPositionsV2` ABI, no `AsterPositionsProvider` (fix #11) — all moved to Phase 2.
- [ ] No new `console.*` calls; all logs use `createLogger`.
- [ ] `STATUS.md` updated under HTTP API table with the new route; `output/aster/status.md` exists and documents the boot verification convention.

---

# Phase 2 — Buy / short execution

**Demo:** `/stock buy $1 AAPL` produces three sign requests on a test account, all autosigned in one mini-app session, ending with a BSC explorer link. The user's USDC.bsc balance lands as USDC.avax via the recovery path when the open is forced to revert.

## P2.1 — Add `STOCK` to `INTENT_COMMAND`

**File:** `be/src/helpers/enums/intentCommand.enum.ts`

Add:
```ts
STOCK = "/stock",
```

The existing `parseIntentCommand` picks it up automatically.

## P2.2 — Loyalty action types

**File:** `be/src/use-cases/implementations/loyaltyUseCase.ts` and the `loyalty_action_types` seed

Add three rows (via `loyalty_action_types` seed file used at season start):
- `stock_open_long`
- `stock_open_short`
- `stock_close`

Add labels in `loyaltyCapability.ts` `ACTION_LABELS` (mirror `send_native` / `send_erc20` precedent):
```ts
stock_open_long:  "stock buy",
stock_open_short: "stock short",
stock_close:      "stock close",
```

## P2.3 — Cross-chain delegation grant in onboarding

**File:** `be/src/adapters/implementations/input/http/httpServer.ts`

`GET /delegation/approval-params` and `GET/POST /delegation/grant` already accept implicit defaults. Extend:

- `GET /delegation/approval-params?chainId=56` — returns BSC defaults: USDC.bsc + native BNB synthesised. Reuse `getNativeTokenInfo(56)`.
- `GET /delegation/grant?chainId=56` — returns BSC delegations only.
- `POST /delegation/grant` — accepts `chainId` in body. Existing handler already keys on token rows which have `chainId`; verify it doesn't collapse cross-chain rows.

The bulk of the multi-chain delegation orchestration lives **in the FE** — the BE just needs to accept and persist the BSC rows. Verify `token_delegations` schema already has `chainId` (it does — see `STATUS.md` token_delegations row).

## P2.4 — `StockUseCase`

**New file:** `be/src/use-cases/implementations/stock.usecase.ts`

**Chain-agnostic by construction.** This use-case must not hardcode chain IDs. Per the user's locked constraint ("the bsc lock is only applied to aster provider"):
- **Home chain** comes from `CHAIN_CONFIG.chainId` (the deployment's home chain — Avalanche today, but configurable).
- **Venue chain** comes from `this.deps.broker.venueChainId` (the broker port exposes it precisely so use-cases stay agnostic).

```ts
import type { IStockUseCase, BuyPlanInput, ClosePlanInput, SetExitsPlanInput, StockExecutionPlan, StockExecutionStep, PositionResolution } from "../interface/input/stock.interface";
import type { IStockBrokerProvider } from "../interface/output/stocks/stockBrokerProvider.interface";
import type { IStockPositionsProvider, StockPosition } from "../interface/output/stocks/stockPositionsProvider.interface";
import type { IStockPriceOracle } from "../interface/output/stocks/stockPriceOracle.interface";
import type { IStockPairRegistry } from "../interface/output/stocks/stockPair.interface";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";
import type { IRelayClient } from "../interface/output/relay.interface";
import type { ITokenRegistryService } from "../interface/output/tokenRegistry.interface";
import { toRaw } from "../../helpers/bigint";
import { CHAIN_CONFIG, getUsdcAddress } from "../../helpers/chainConfig";
import { erc20Abi } from "viem";
import { createLogger } from "../../helpers/observability/logger";

const log = createLogger("stockUseCase");

export class StockUseCaseImpl implements IStockUseCase {
  constructor(private readonly deps: {
    broker: IStockBrokerProvider;
    positions: (userId: string) => IStockPositionsProvider;
    oracle: IStockPriceOracle;
    pairs: IStockPairRegistry;
    /** Fix #8: cross-chain swap planning goes through the port, not the relay client. */
    crossChainSwap: ICrossChainSwapPlanner;
    userProfileRepo: IUserProfileDB;
    tokenRegistry: ITokenRegistryService;
    // Fix #7: venuePublicClient removed; broker.getCollateralBalance replaces it.
  }) {}

  private get homeChainId(): number  { return CHAIN_CONFIG.chainId; }
  private get venueChainId(): number { return this.deps.broker.venueChainId; }

  async buildOpenPlan(input: BuyPlanInput): Promise<StockExecutionPlan> {
    const symbol = input.symbol.toUpperCase();
    if (!this.deps.pairs.resolve(symbol)) throw new Error(`unsupported symbol ${symbol}`);
    const profile = await this.deps.userProfileRepo.findByUserId(input.userId);
    const sca = profile?.smartAccountAddress as `0x${string}` | undefined;
    if (!sca) throw new Error("user has no smart account address");

    const usdcHome = getUsdcAddress(this.homeChainId);
    if (!usdcHome) throw new Error("home-chain USDC not configured");
    const usdcHomeRow = await this.deps.tokenRegistry.findByAddressAndChain(usdcHome, this.homeChainId);
    if (!usdcHomeRow) throw new Error("home USDC not in token registry");

    // 1. Mark price (used as on-chain price field on openMarketTrade).
    const mark = await this.deps.oracle.markPrice(symbol);
    const markFixed1e8 = toFixed(mark.priceUsd, 8);

    // 2. Cross-chain swap leg (home USDC → venue USDC), via the port (fix #8).
    const amountHomeRaw = toRaw(input.amountUsd, usdcHomeRow.decimals);
    const swap = await this.deps.crossChainSwap.plan({
      user: sca, recipient: sca,
      fromChainId: this.homeChainId, toChainId: this.venueChainId,
      fromToken: usdcHome, toToken: this.deps.broker.collateralToken.address,
      amountRaw: amountHomeRaw,
    });
    if (swap.txs.length === 0) throw new Error("cross-chain swap planner returned no txs");
    if (!swap.expectedOutRaw || swap.expectedOutRaw === "0") {
      throw new Error("swap planner missing expectedOutRaw — cannot size open leg");
    }

    // 3. Fix #6 — derive qty from collateralAmountRaw (post-fee/slippage),
    //    NOT from the user's input USD. Otherwise qty * markPrice ≠ amountIn
    //    and the open reverts with wrong leverage.
    const collateralAmountRaw = swap.expectedOutRaw; // venue-chain decimals
    const collateralUsdHuman = formatUnits(BigInt(collateralAmountRaw), this.deps.broker.collateralToken.decimals);
    const qty = divFixed(collateralUsdHuman, mark.priceUsd, 10); // qty in 1e10, 1x leverage locked

    const openTxs = await this.deps.broker.buildOpenPositionTxs({
      traderAddress: sca,
      symbol,
      isLong: !input.isShort,
      collateralAmountRaw,
      qtyFixed1e10: qty,
      markPriceFixed1e8: markFixed1e8,
      stopLossFixed1e8: undefined,
      takeProfitFixed1e8: undefined,
    });

    const steps: StockExecutionStep[] = [];
    // Swap legs — all on home chain. Tag the LAST swap step with spend
    // metadata for the home-chain USDC delegation bookkeeping.
    swapTxs.forEach((tx, i) => {
      const isLast = i === swapTxs.length - 1;
      steps.push({
        label: swapTxs.length === 1 ? "Bridge USDC to BSC" : `Bridge step ${i + 1}/${swapTxs.length}`,
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: tx.value ?? "0",
        chainId: this.homeChainId,
        spendTokenAddress: isLast ? usdcHome.toLowerCase() : undefined,
        spendAmountRaw:    isLast ? amountHomeRaw : undefined,
      });
    });
    // Venue legs. No spend bookkeeping — venue USDC is internal to the SCA.
    openTxs.forEach((tx, i) => {
      const total = openTxs.length;
      const label = total === 1 ? "Open stock position" : i === 0 && total === 2 ? "Approve USDC for Aster" : "Open stock position";
      steps.push({
        label,
        to: tx.to, data: tx.data, value: tx.value,
        chainId: this.venueChainId,
      });
    });

    log.info({ step: "plan-built", userId: input.userId, symbol, isShort: !!input.isShort, amountUsd: input.amountUsd, stepCount: steps.length, venueChainId: this.venueChainId }, "open plan built");

    return {
      kind: input.isShort ? "short" : "buy",
      symbol,
      steps,
      quoteSummary: buildOpenQuoteSummary({ symbol, amountUsd: input.amountUsd, mark: mark.priceUsd, isShort: !!input.isShort, stepCount: steps.length }),
    };
  }

  async buildClosePlan(input: ClosePlanInput): Promise<StockExecutionPlan> {
    const profile = await this.deps.userProfileRepo.findByUserId(input.userId);
    const sca = profile?.smartAccountAddress as `0x${string}` | undefined;
    if (!sca) throw new Error("user has no smart account address");

    // Fix #1 — resolve symbol from positions by tradeHash (no extra RPC; the
    // capability already loads positions for disambiguation upstream and we
    // can re-use the cached list).
    const positions = await this.deps.positions(input.userId).list(sca);
    const match = positions.find((p) => p.tradeHash === input.tradeHash);
    if (!match) throw new Error(`no open position with tradeHash ${input.tradeHash.slice(0, 10)}`);

    const closeTxs = await this.deps.broker.buildClosePositionTxs({ tradeHash: input.tradeHash });
    return {
      kind: "close",
      symbol: match.symbol,
      steps: closeTxs.map((tx) => ({
        label: "Close stock position",
        to: tx.to, data: tx.data, value: tx.value, chainId: this.venueChainId,
      })),
      quoteSummary: `Closing ${match.symbol} ${match.side} ($${match.notionalUsd}).`,
    };
  }

  async buildSetExitsPlan(input: SetExitsPlanInput): Promise<StockExecutionPlan> {
    const profile = await this.deps.userProfileRepo.findByUserId(input.userId);
    const sca = profile?.smartAccountAddress as `0x${string}` | undefined;
    if (!sca) throw new Error("user has no smart account address");
    // Fix #1 — same lookup as buildClosePlan.
    const positions = await this.deps.positions(input.userId).list(sca);
    const match = positions.find((p) => p.tradeHash === input.tradeHash);
    if (!match) throw new Error(`no open position with tradeHash ${input.tradeHash.slice(0, 10)}`);

    const sl = input.stopLossUsd ? toFixed(input.stopLossUsd, 8) : "0";
    const tp = input.takeProfitUsd ? toFixed(input.takeProfitUsd, 8) : "0";
    const txs = await this.deps.broker.buildSetExitsTxs({
      tradeHash: input.tradeHash, stopLossFixed1e8: sl, takeProfitFixed1e8: tp,
    });
    return {
      kind: "set_exits",
      symbol: match.symbol,
      steps: txs.map((tx) => ({
        label: "Update SL/TP",
        to: tx.to, data: tx.data, value: tx.value, chainId: this.venueChainId,
      })),
      quoteSummary: "Updating exits…",
    };
  }

  /**
   * Build a self-contained "send the SCA's venue-USDC home" plan. Used by
   * the capability's recovery branch when an open or close fails on the
   * venue chain leaving funds stranded.
   *
   * Returns null when the SCA has no venue-USDC balance to bridge.
   */
  async buildReturnSwapPlan(input: { userId: string }): Promise<StockExecutionPlan | null> {
    const profile = await this.deps.userProfileRepo.findByUserId(input.userId);
    const sca = profile?.smartAccountAddress as `0x${string}` | undefined;
    if (!sca) throw new Error("user has no smart account address");

    // Fix #7: use the broker port instead of a leaked publicClient.
    const balance = await this.deps.broker.getCollateralBalance(sca);
    if (balance === 0n) return null;

    const usdcHome = getUsdcAddress(this.homeChainId);
    if (!usdcHome) throw new Error("home-chain USDC not configured");

    // Fix #8: planner port instead of relay client.
    const swap = await this.deps.crossChainSwap.plan({
      user: sca, recipient: sca,
      fromChainId: this.venueChainId, toChainId: this.homeChainId,
      fromToken: this.deps.broker.collateralToken.address, toToken: usdcHome,
      amountRaw: balance.toString(),
    });
    if (swap.txs.length === 0) return null;

    return {
      // Fix #2: explicit recovery kind, not a reused "close".
      kind: "recovery",
      symbol: "",
      steps: swap.txs.map((tx, i) => ({
        label: swap.txs.length === 1 ? "Return USDC to home chain" : `Return step ${i + 1}/${swap.txs.length}`,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        chainId: this.venueChainId,
      })),
      quoteSummary: "Returning your funds to Avalanche…",
    };
  }

  async listPositions(userId: string): Promise<StockPosition[]> {
    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress) return [];
    return this.deps.positions(userId).list(profile.smartAccountAddress as `0x${string}`);
  }

  async resolvePositionForSymbol(userId: string, symbol: string): Promise<PositionResolution> {
    const all = await this.listPositions(userId);
    const matches = all.filter((p) => p.symbol === symbol.toUpperCase());
    if (matches.length === 0) return { kind: "none" };
    if (matches.length === 1) return { kind: "one", position: matches[0]! };
    return { kind: "many", positions: matches };
  }
}

function toFixed(humanUsd: string, decimals: number): string {
  // "189.42" → "18942000000" (when decimals=8). Pure string math via toRaw.
  return toRaw(humanUsd, decimals);
}
function divFixed(numHuman: string, denHuman: string, qtyDecimals: number): string {
  // qty = numerator / denominator scaled to 1e<qtyDecimals>.
  // Use BigInt math — never floats. Pseudocode:
  //   qty_raw = (numHuman * 1e18) / denHuman_scaled, then re-scale to 1e<qtyDecimals>.
  // Implement carefully; precision tests required.
  return "0"; // TODO at impl
}
function buildOpenQuoteSummary(_args: any): string { return "*Stock buy quote*\n…"; }
```

**Note on balance reads (post fix #7):** the use-case no longer holds a `venuePublicClient`. Venue-chain balance reads go through `IStockBrokerProvider.getCollateralBalance(trader)`, which the adapter implements using its own viem client. The port stays clean and the use-case stays chain-agnostic.

**Note on cross-chain swap (post fix #8):** the use-case takes `ICrossChainSwapPlanner`. The Phase 2 implementation `RelayCrossChainSwapPlanner` adapts the existing relay client to the port shape (consume `currencyOut.amount`, return `expectedOutRaw`). Putting the venue/decimals contract behind the port is what makes the Phase 2 fix #6 (qty derived from `expectedOutRaw`) safe across collateral-token decimal changes.

## P2.5 — `StockCapability`

**New file:** `be/src/adapters/implementations/output/capabilities/stockCapability.ts`

Pattern: mix of `swapCapability.ts` (for the autosign loop + chain-aware sign requests) and `yieldCapability.ts` (for the `executeSignSteps` helper).

Capability deps must reference `IStockUseCase` (interface from `interface/input/stock.interface.ts`), **not** the concrete `StockUseCaseImpl`. Mirror the `swapCapability` precedent (`intentUseCase: IIntentUseCase`).

Key differences from existing capabilities:
1. **Sub-verb parsing.** Pre-compile, peel off the sub-verb (`buy`/`short`/`close`/`sl`/`tp`) from the raw text. Pass the rest through schema compile.
2. **Cross-chain step list.** Each `SigningRequestRecord` gets its own `chainId` (home chain for swap legs, venue chain for venue legs). The FE picks per-request chain via `SignRequest.chainId` (already supported per the 2026-04-27 swap fix).
3. **Recovery branch — DOES NOT chain in the same mini-app session.** See "Recovery flow" below for the corrected design.
4. **Aegis Guard pre-flight check** on the home-chain USDC budget at the start of `runOpen`, mirroring `swapCapability`'s call to `checkTokenDelegation`. If `guard.ok === false`, return the reapproval mini-app artifact immediately (no swap, no open).
5. **Position disambiguation.** For `close`/`sl`/`tp`, call `resolvePositionForSymbol`; emit `inline_keyboard` artifact with one button per position when `kind === "many"`. Callback data: `stock:close:<tradeHashShort>` / `stock:sl:<tradeHashShort>:<priceUsd>`. Use `triggers.callbackPrefix = "stock"`.

### Recovery flow (CORRECTED design)

**The previous draft was wrong.** It said the capability would "append a fresh sign request" to the same mini-app session after a venue-leg revert. That doesn't work: the FE's `fetchNextRequest` only chains on **success** (see `fe/privy-auth/src/utils/fetchNextRequest.ts` and `SignHandler.tsx`). On failure the mini-app shows an error screen and the user closes it.

**Correct design:**
1. The open/close loop fails on a venue-chain step revert. `executeSignSteps` returns `{ aborted: true, artifact: <error chat> }`.
2. Capability checks `STOCK_RECOVERY_ENABLED && errorCode !== "user_rejected" && errorCode !== "expired"`.
3. Capability calls `stockUseCase.buildReturnSwapPlan({ userId })`. If null (no venue balance), surface the original failure unchanged.
4. Capability emits **two artifacts in sequence**:
   - `chat`: "Stock trade failed: <reason>. Tap below to return your funds to Avalanche."
   - `mini_app`: a fresh `SignRequest` (autoSign true) for the first return-swap step. Subsequent steps stored in `miniAppRequestCache` per the standard chaining pattern.
5. The capability's `run` method **returns** after emitting the `mini_app` artifact. The recovery is a separate mini-app session driven by the user's tap. State to track this is keyed on `pending_collection` (existing mechanism) so that if the user re-issues `/stock` mid-recovery the dispatcher behaves sanely.
6. On recovery resolution (success or failure), `notifyResolved.ts` (or its hook) emits a final chat message. If the recovery itself fails, we surface both tx hashes and `error: "stock_recovery_failed"`.

This preserves the "user signs nothing past onboarding" promise on the happy path and keeps the failure path within the existing mini-app contract — no FE changes needed beyond the error-code classifier additions.

**Stretch (out of scope for v0):** if we later want zero-tap auto-recovery, extend the FE to poll `fetchNextRequest` on terminal failure too. Track in backlog.

Skeleton:

```ts
export class StockCapability implements Capability<StockParams> {
  readonly id = "intent_stock";
  readonly triggers: TriggerSpec = {
    commands: [INTENT_COMMAND.STOCK],
    callbackPrefix: "stock",
  };

  constructor(private readonly deps: StockCapabilityDeps) {}

  async collect(ctx: CapabilityCtx, resuming?: Record<string, unknown>): Promise<CollectResult<StockParams>> {
    if (ctx.input.kind === "callback") return this.handleCallback(ctx, ctx.input.data);
    if (ctx.input.kind !== "text") return this.abort("Unexpected input.");
    const text = ctx.input.text;

    // Sub-verb parse — strip "/stock" prefix and inspect the next word.
    const stripped = text.replace(/^\/stock\s*/i, "").trim();
    const verb = stripped.split(/\s+/)[0]?.toLowerCase();
    const VERBS = new Set(["buy", "short", "sell", "close", "sl", "tp", "positions"]);
    if (!verb || !VERBS.has(verb)) {
      return { kind: "ask", question: "Try /stock buy $100 AAPL · /stock short $100 TSLA · /stock close NVDA · /stock sl AAPL 150 · /stock tp AAPL 220" };
    }

    // Each verb has its own compile / resolve path. Implement separately:
    if (verb === "buy" || verb === "short")  return this.collectOpen(ctx, stripped, verb === "short", resuming);
    if (verb === "sell" || verb === "close") return this.collectClose(ctx, stripped, resuming);
    if (verb === "sl")                        return this.collectExits(ctx, stripped, "sl", resuming);
    if (verb === "tp")                        return this.collectExits(ctx, stripped, "tp", resuming);
    return this.abort("Unknown stock action.");
  }

  async run(params: StockParams, ctx: CapabilityCtx): Promise<Artifact> {
    // Branch on params.kind. Each branch:
    //   1. Build StockExecutionPlan via this.deps.stockUseCase.
    //   2. (Optional) Aegis Guard check on home-chain USDC.
    //   3. emit chat → quoteSummary.
    //   4. executeSignSteps(steps) — same loop shape as swapCapability.
    //   5. On open-failure final step → run recovery if STOCK_RECOVERY_ENABLED.
    //   6. Award loyalty fire-and-forget on success.
  }

  private async executeSignSteps(opts: {
    ctx: CapabilityCtx;
    steps: StockExecutionStep[];
    buttonText: string;
    promptText: string;
  }): Promise<{ aborted: true; artifact: Artifact } | { aborted: false; txHashes: string[] }> {
    // Copy-paste the body from yieldCapability.executeSignSteps and modify:
    // - SigningRequestRecord.tokenAddress / amountRaw come from step.spendTokenAddress / step.spendAmountRaw
    // - SignRequest.chainId comes from step.chainId (NOT a single capability-wide chainId)
    // - Final step's resolution failure may trigger recovery — return the rejection up to run() so it can decide.
    return { aborted: false, txHashes: [] };
  }
}
```

**Recovery flow implementation steps** (per the corrected design above):
1. After `executeSignSteps` returns `{ aborted: true, ... }`, inspect the final resolution's `errorCode`.
2. If recovery is appropriate (`STOCK_RECOVERY_ENABLED && code not in {user_rejected, expired}`), call `stockUseCase.buildReturnSwapPlan({ userId })`.
3. If plan is null (no balance to return), return the original error chat artifact unchanged.
4. Otherwise, emit `chat` ("Open trade failed: <friendly reason>. Tap below to return your funds.") and then emit `mini_app` for the first recovery step. Store steps 2..N in `miniAppRequestCache` per the existing chaining contract.
5. The capability's `run()` returns after the `mini_app` emission. Recovery resolution is observed via the standard `signingRequest.usecase.resolveRequest` → `notifyResolved.ts` path. Add a recovery-specific branch in `notifyResolved.ts` that emits the final user-facing message (success: "Returned. [explorer]" / failure: "Recovery failed — contact support. Failure: <hash>, Recovery: <hash>").

## P2.5b — `notifyResolved.ts` and `interpretSignError` lockstep additions

**File:** `be/src/helpers/notifyResolved.ts`

The FE's `interpretSignError.ts` adds six new `SignErrorCode` values (see FE plan P2.4). Per the existing convention in `STATUS.md` ("New sign-error code: add to FE `interpretSignError.ts` AND BE `notifyResolved.ts` recovery branch. String is the contract."), the BE must mirror them.

Add a branch in the resolution-failure path that maps each code to a user-facing chat message:

| `errorCode` | BE-side response |
|---|---|
| `aster_pair_inactive`           | Chat: "This stock pair is not currently tradable. Try a different symbol." |
| `aster_min_size`                | Chat: "Trade size is below the minimum. Try a larger amount." |
| `aster_max_position`            | Chat: "You've hit the per-user position limit for this asset." |
| `aster_oracle_stale`            | Chat: "Stock price oracle is stale. Please try again in a moment." |
| `aster_insufficient_collateral` | Trigger the recovery flow (see P2.5). |
| `stock_recovery_failed`         | Chat: "Recovery failed — please contact support. Failure tx: …, recovery tx: …" |

Codes are the contract. Adding a code on one side without the other is forbidden.

## P2.5c — Pre-merge audit: `INTENT_COMMAND` consumers

Adding `STOCK = "/stock"` may surface in unexpected places. Before merging phase 2, run:

```bash
grep -rn "INTENT_COMMAND\b" be/src/ | grep -v "\.test\."
```

Audit each match for:
- `switch` statements over the enum without a `default` branch.
- `Object.values(INTENT_COMMAND)` iterations beyond `assistant.di.ts:806` (the one we already patched).
- `parseIntentCommand` consumers that assume a closed set.

Document audit findings in the PR description ("audited N call sites, all handle unknown values gracefully" or list the fixes applied).

## P2.6 — DI registration

**File:** `be/src/adapters/inject/assistant.di.ts` — `getCapabilityDispatcher()` (around line 760)

**Phase 2 also flips `relayEnabled: true` on the BSC chain registry entry** (P1.1) and adds an acceptance smoke for `/swap … to bsc`. Phase 1 had it false to prevent surprise behaviour.

Because `getStockBrokerProvider` is now async (P1.8), `getCapabilityDispatcher` must `await` it. The method already returns a promise where Redis isn't ready (it's idempotent), so converting to async is safe — but verify all call sites of `getCapabilityDispatcher` already await it (they do; CLIs treat it as a promise).

Add after the `SwapCapability` block:

```ts
if (this._signingRequestUseCase) {
  const broker = await this.getStockBrokerProvider();
  const stockUseCase: IStockUseCase = new StockUseCaseImpl({
    broker,
    positions: (uid) => this.getStockPositionsProvider(uid),
    oracle: this.getStockPriceOracle(),
    pairs: this.getStockPairRegistry(),
    crossChainSwap: this.getCrossChainSwapPlanner(), // fix #8
    userProfileRepo: sqlDB.userProfiles,
    tokenRegistry: this.getTokenRegistryService(),
    // fix #7: venuePublicClient removed — broker.getCollateralBalance covers the recovery balance read.
  });
  registry.register(
    new StockCapability({
      stockUseCase,                                         // typed as IStockUseCase
      signingRequestUseCase: this._signingRequestUseCase,
      miniAppRequestCache: this.getMiniAppRequestCache(),
      tokenDelegationDB: this.getTokenDelegationRepo(),
      executionEstimator: this.getExecutionEstimator(),
      userProfileRepo: sqlDB.userProfiles,
      loyaltyUseCase: this.getLoyaltyUseCase(),
    }),
  );
}
```

The `for (const command of Object.values(INTENT_COMMAND))` loop near line 806 must also exclude `INTENT_COMMAND.STOCK` (so `SendCapability` doesn't claim it):

```ts
if (command === INTENT_COMMAND.STOCK) continue;
```

## P2.7 — Phase 2 acceptance gate

- [ ] `/stock buy $1 AAPL` produces three sign requests (1 swap, 1 approve, 1 open) on a test account, all autosigned in one mini-app session.
- [ ] Final result message includes `getExplorerTxUrl(56, openTxHash)`.
- [ ] Forced revert (e.g. tweak the open's slippage to 100% in a fork test) emits a chat + a **fresh** mini-app artifact for the recovery swap. User taps, signs once, funds return home. (Recovery is NOT in the same mini-app session — see P2.5 corrected design.)
- [ ] `intent_executions` row created with `chain_id = 56` and intent action set correctly.
- [ ] Loyalty `stock_open_long` fire-and-forget award visible in `loyalty_points_ledger`.
- [ ] Logs include `step` events `started → swap-submitted → approve-submitted → open-submitted → succeeded`.
- [ ] Every `try/catch` in new files logs before returning/rethrowing.
- [ ] `output/capabilities/status.md` updated with the stock conventions (sub-verb parsing, recovery branch as a separate session, dual-chain step lists).
- [ ] **F2 audit:** `INTENT_COMMAND` grep audit (P2.5c) documented in PR description.
- [ ] **F3 lockstep:** `notifyResolved.ts` recovery branch contains every code added to FE `interpretSignError.ts` in the same PR.
- [ ] **`/swap to bsc` acceptance smoke:** test cross-chain swap to BSC works (paired with flipping `relayEnabled: true`).
- [ ] No hardcoded chain ids in `stock.usecase.ts`. Re-grep before merge.
- [ ] No hardcoded USDC.bsc address or decimals in `asterBrokerProvider.ts`. Re-grep before merge.
- [ ] `IStockUseCase` is what `StockCapability` accepts in deps — not the concrete class. `grep "stockUseCase: StockUseCase" stockCapability.ts` returns nothing.
- [ ] **Fix #1** — `grep 'symbol: "?"' be/src/use-cases/implementations/stock.usecase.ts` returns nothing. Close/SetExits success messages render the resolved symbol (e.g. "Closing AAPL long…"), not a placeholder.
- [ ] **Fix #2** — `kind: "recovery"` appears in `StockExecutionPlan` union; `notifyResolved.ts` recovery branch routes on `plan.kind === "recovery"`, not on a reused `"close"`.
- [ ] **Fix #6** — `qty` is computed AFTER the swap quote, from `collateralAmountRaw`. Reading `stock.usecase.ts buildOpenPlan`, the order is mark → swap.plan → derive qty → broker.buildOpenPositionTxs. A unit test forces a swap quote with `expectedOutRaw < amountHomeRaw` and asserts qty scales accordingly.
- [ ] **Fix #7** — `grep -n "venuePublicClient" be/src/use-cases/implementations/stock.usecase.ts` returns nothing; recovery balance comes from `broker.getCollateralBalance`.
- [ ] **Fix #8** — `grep -n "relayClient" be/src/use-cases/implementations/stock.usecase.ts` returns nothing; cross-chain swaps go through `ICrossChainSwapPlanner`.

---

# Phase 3 — Close, SL/TP, /positions

**Demo:** users can `/stock close TSLA`, `/stock sl AAPL 150`, `/stock tp AAPL 220`, and `/positions` returns an LLM-summarised view.

## P3.1 — Close path

Already implemented partly in `StockUseCaseImpl.buildClosePlan`. The capability layer:

1. `resolvePositionForSymbol(userId, symbol)`. If `kind === "none"` reply "no open X position". If `kind === "many"` emit inline keyboard:
   ```
   AAPL long $100 (entry 175.32)   → stock:close-pick:<tradeHashShort>
   AAPL long $50  (entry 178.20)   → stock:close-pick:<tradeHashShort>
   ```
   Pending state stores the original `text`. On callback, re-enter `runClose` with the picked `tradeHash`.
2. Run `buildClosePlan({ userId, tradeHash })` → executeSignSteps for the close.
3. After the close txHash, read the SCA's USDC.bsc balance and append a return-swap step (Relay USDC.bsc → USDC.avax exact-in). Same `executeSignSteps` loop.
4. Award `stock_close` loyalty.

## P3.2 — SL/TP path

`/stock sl AAPL 150`:
1. Schema compile extracts `{ symbol: "AAPL", priceUsd: "150" }`.
2. Resolve position with same disambiguation rules.
3. **Important: read existing SL/TP from the position so we don't clobber.** When user is setting only SL, pass through the position's current TP (and vice versa). `IStockPositionsProvider.list` already returns both fields.
4. Build `set_exits` plan, executeSignSteps. No loyalty award.

## P3.3 — `/positions` command

Reuse `assistantChatCapability` plumbing — the new `get_stock_positions` tool from phase 1 already does the heavy lifting. `/positions` slash command becomes a thin trigger that prompts the agent:

> "Summarize the user's open Aster stock positions in a friendly paragraph."

**Implementation choice (locked):** rather than create a new capability, add `/positions` to the existing `INTENT_COMMAND` enum (or an alias mapping) and route it through `AssistantChatCapability` with a seeded user message. Cleanest path: register a command-mapping (`POST /command-mappings`) at boot for `positions → get_stock_positions` so the existing command-mapping plumbing handles it. Verify with the team whether you prefer a dedicated capability or the seed-message route — both are 30 LOC.

## P3.4 — Phase 3 acceptance gate

- [ ] `/stock close TSLA` (single position) closes + returns USDC home in one mini-app session.
- [ ] `/stock close AAPL` (multi-position) renders inline keyboard; tap closes the right tradeHash.
- [ ] `/stock sl AAPL 150` updates only stop-loss, preserving existing take-profit.
- [ ] `/positions` returns a paragraph + table.
- [ ] All new commands in Telegram help text and `STATUS.md` Telegram commands table.

---

# Cross-cutting checklists

## Logging conventions (apply at every step)

Per CLAUDE.md mandatory logging rules:

- New scopes: `stockCapability`, `stockUseCase`, `asterBrokerProvider`, `asterPositionsProvider`, `asterPriceOracle`, `asterPairRegistry`, `asterDiamondClient`, `getStockPositionsTool`, `getStockQuoteTool`.
- New metadata fields (document in `output/capabilities/status.md`): `symbol`, `side`, `tradeHashShort` (12 chars), `markPrice`, `notionalUsd`, `venueChainId`, `recovery: boolean`.
- **Never log:** raw `OpenDataInput`, full `tradeHash` (use `tradeHashShort`), broker IDs in production, USDC.bsc balances in `info` (use `debug`).
- Step events for `stockCapability`: `started`, `quoted`, `swap-submitted`, `approve-submitted`, `open-submitted`, `close-submitted`, `exits-submitted`, `recovery-started`, `recovery-succeeded`, `recovery-failed`, `succeeded`, `failed`.

## Privy + auth

No new auth surfaces. All new HTTP routes use `resolveUserId` (Privy bearer) except `/stocks/pairs` which is unauthenticated (matches `/tokens` precedent).

## Database migration concerns

**No new tables.** Schema changes:
- `loyalty_action_types` seed gets three new rows. Use `npm run db:generate --name add_stock_loyalty_actions` to scaffold a custom migration if rows are seeded via SQL; otherwise add to the existing seed script and document.
- `intent_actions` enum gains `STOCK_TRADE`. Use `drizzle-kit generate --custom --name add_stock_intent_action` and write the `ALTER TYPE` idempotently per the migrations safety rules.

**Do not** hand-resolve any `_journal.json` conflicts. Rebase, drop, regenerate.

## Risks / gotchas

- **18-decimal USDC.bsc.** Every BigInt math path must source decimals from the token row, not hardcode 6. Add a unit test asserting `toRaw("100", 18)` is `100000000000000000000`.
- **Relay's `currencyOut.amount`** is post-fee, post-slippage estimate. The actual delivered USDC.bsc may be lower. v0 accepts that — recovery handles the open revert.
- **Diamond proxy upgrades.** If Aster upgrades the Diamond, `pairsV4()` selector or struct may shift. Boot verification catches struct shifts (decode fails) and selector shifts (call reverts). Failures throw at boot — process stays down until ABI is refreshed.
- **Intent classifier might route "buy TSLA" to `BuyCapability`** (the onramp). Update the classifier's tool-index priority so `STOCK` outranks `BUY` when a stock symbol is present, or add a deterministic pre-classifier pass: if message starts with `/stock`, skip the LLM classifier entirely (existing pattern — `parseIntentCommand` already handles slash-routed flows).

## File-creation summary

| Phase | Path | Action |
|---|---|---|
| 1 | `be/src/helpers/chainConfig.ts` | edit — add BSC entry |
| 1 | `be/.env.example` | edit — `BSC_USDC` |
| 1 | `be/drizzle/seed/tokenRegistry.ts` | edit — USDC.bsc row |
| 1 | `be/src/helpers/env/asterEnv.ts` | new |
| 1 | `be/src/adapters/implementations/output/aster/asterAbi.ts` | new |
| 1 | `be/src/adapters/implementations/output/aster/asterDiamond.client.ts` | new |
| 1 | `be/src/adapters/implementations/output/aster/asterPairRegistry.ts` | new |
| 1 | `be/src/adapters/implementations/output/aster/asterPriceOracle.ts` | new |
| 1 | `be/src/adapters/implementations/output/aster/asterBrokerProvider.ts` | new (with `getCollateralBalance` per fix #7) |
| 1 | `be/src/adapters/implementations/output/aster/status.md` | new |
| 1 | `be/src/use-cases/interface/output/stocks/stockBrokerProvider.interface.ts` | new |
| 1 | `be/src/use-cases/interface/output/stocks/stockPriceOracle.interface.ts` | new |
| 1 | `be/src/use-cases/interface/output/stocks/stockPair.interface.ts` | new |
| 1 | `be/src/use-cases/interface/output/stocks/crossChainSwapPlanner.interface.ts` | new (fix #8) |
| 2 | `be/src/use-cases/interface/input/stock.interface.ts` | new — `IStockUseCase`. Moved to Phase 2 because it depends on `StockPosition` which lives with the deferred positions provider; defining it in Phase 1 alone would force a parallel placeholder type that we'd then have to delete. |
| 1 | `be/src/adapters/inject/assistant.di.ts` | edit — wire singletons + soft-fail boot verify (fix #9) |
| 1 | `be/src/adapters/implementations/input/http/httpServer.ts` | edit — two routes (`/stocks/pairs`, `/stocks/quote`) |
| 1 | `be/scripts/verify-aster-pairs.ts` | new |
| 2 | `be/src/adapters/implementations/output/aster/asterPositionsProvider.ts` | new (deferred from Phase 1 — fix #11) |
| 2 | `be/src/use-cases/interface/output/stocks/stockPositionsProvider.interface.ts` | new (deferred from Phase 1 — fix #11) |
| 2 | `be/src/adapters/implementations/output/stocks/relayCrossChainSwapPlanner.ts` | new (impl of fix #8 port) |
| 2 | `be/src/adapters/implementations/output/tools/system/getStockPositions.tool.ts` | new (deferred — fix #10) |
| 2 | `be/src/adapters/implementations/output/tools/system/getStockQuote.tool.ts` | new (deferred — fix #10) |
| 2 | `be/src/adapters/implementations/input/http/httpServer.ts` | edit — `GET /stocks/positions` (deferred — fix #11) |
| 2 | `be/src/adapters/implementations/output/systemToolProvider.concrete.ts` | edit — register new tools (deferred) |
| 1 | `be/package.json` | edit — `verify:aster` script |
| 2 | `be/src/helpers/enums/intentCommand.enum.ts` | edit — `STOCK` |
| 2 | `be/src/use-cases/implementations/stock.usecase.ts` | new |
| 2 | `be/src/adapters/implementations/output/capabilities/stockCapability.ts` | new |
| 2 | `be/src/adapters/implementations/output/capabilities/loyaltyCapability.ts` | edit — `ACTION_LABELS` |
| 2 | `be/drizzle/seed/loyaltyActionTypes.ts` (or equivalent) | edit |
| 2 | drizzle custom migration | new — `intent_actions` enum |
| 2 | `be/src/adapters/inject/assistant.di.ts` | edit — `StockCapability` registration + exclude from `SendCapability` loop + flip BSC `relayEnabled: true` |
| 2 | `be/src/helpers/notifyResolved.ts` | edit — six new error-code branches (lockstep with FE `interpretSignError`) |
| 2 | `be/src/helpers/chainConfig.ts` | edit — flip BSC `relayEnabled` from `false` (phase 1) to `true` (phase 2) |
| 2 | `be/STATUS.md` | edit — Telegram commands + HTTP API tables |
| 2 | `be/src/adapters/implementations/output/capabilities/status.md` | append stock notes |
| 3 | `stockCapability.ts` (close, sl, tp paths) | edit |
| 3 | `be/src/use-cases/implementations/commandMapping.usecase.ts` boot seed | edit — `/positions` mapping |

## Final commit checklist

Per the "after implementing" rule:
- [ ] `STATUS.md` updated with new chain (56), new env vars, new HTTP routes, new Telegram commands, new conventions (1x leverage default, dual-chain step lists, recovery branch).
- [ ] `output/capabilities/status.md` appended with stock-specific notes.
- [ ] `output/aster/status.md` exists and is current.
- [ ] FE `aaConfig.ts` byte-identical to BE — re-grep before merging.
- [ ] `npm run verify:aster` passes in CI.
- [ ] No `console.*` in any new file.
- [ ] Manual test on a live mainnet account with $1 spend, then $5, before opening to other users.
