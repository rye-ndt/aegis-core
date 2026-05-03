import {
  avalancheFuji,
  avalanche,
  mainnet,
  base,
  polygon,
  arbitrum,
  optimism,
  type Chain,
} from "viem/chains";
import type { Address } from "viem";
import { YIELD_ENV } from "./env/yieldEnv";
import { YIELD_PROTOCOL_ID } from "./enums/yieldProtocolId.enum";

interface YieldChainConfig {
  stablecoins: Array<{
    symbol: string;
    address: Address;
    decimals: number;
    /** Aave V3 aToken address for this reserve — used as the Messari subgraph `market` id. */
    aTokenAddress?: Address;
  }>;
  protocols: YIELD_PROTOCOL_ID[];
  aave?: { poolAddress: Address; dataProviderAddress: Address };
}

interface ChainEntry {
  chain: Chain;
  nativeSymbol: string;
  name: string;
  /** Ordered list of RPC URLs. First is primary; subsequent are fallbacks. */
  defaultRpcUrls: string[];
  privyNetwork: string;
  /** Common short names the user might type: 'base', 'arb', 'polygon'. */
  aliases: string[];
  /** Relay.link supports this chain for quotes/executions. */
  relayEnabled: boolean;
  /**
   * Env var name that holds the chain's canonical USDC contract address.
   * Looked up at runtime via process.env so deployments can rotate addresses
   * without code changes. Used by `getUsdcAddress(chainId)` for fiat-amount
   * shortcuts ("$5" → USDC) so the resolver can skip token disambiguation.
   */
  usdcEnvKey?: string;
  /** Ankr Advanced API blockchain slug for `ankr_getAccountBalance`. Absent means unsupported. */
  ankrBlockchain?: string;
  yield?: YieldChainConfig;
}

const CHAIN_REGISTRY: Record<number, ChainEntry> = {
  43113: {
    chain: avalancheFuji,
    nativeSymbol: "AVAX",
    name: "Avalanche Fuji",
    defaultRpcUrls: [
      "https://api.avax-test.network/ext/bc/C/rpc",
      "https://avalanche-fuji-c-chain-rpc.publicnode.com",
      "https://rpc.ankr.com/avalanche_fuji",
    ],
    privyNetwork: "avalanche-fuji",
    aliases: ["fuji", "avalanche-fuji"],
    relayEnabled: false,
    usdcEnvKey: "FUJI_USDC",
    // ankrBlockchain intentionally absent — Fuji not supported by Ankr balance API
  },
  43114: {
    chain: avalanche,
    nativeSymbol: "AVAX",
    name: "Avalanche",
    defaultRpcUrls: [
      "https://api.avax.network/ext/bc/C/rpc",
      "https://avalanche-c-chain-rpc.publicnode.com",
      "https://rpc.ankr.com/avalanche",
    ],
    privyNetwork: "avalanche",
    aliases: ["avalanche", "avax"],
    relayEnabled: true,
    usdcEnvKey: "AVAX_USDC",
    ankrBlockchain: "avalanche",
    yield: {
      stablecoins: [
        {
          symbol: "USDC",
          address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" as Address,
          decimals: 6,
          // aUSDC v3 on Avalanche — Aave V3 Messari subgraph market id
          aTokenAddress: "0x625E7708f30cA75bfd92586e17077590C60eb4cD" as Address,
        },
      ],
      protocols: [YIELD_PROTOCOL_ID.AAVE_V3],
      aave: {
        poolAddress: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as Address,
        dataProviderAddress: "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654" as Address,
      },
    },
  },
  1: {
    chain: mainnet,
    nativeSymbol: "ETH",
    name: "Ethereum",
    defaultRpcUrls: [
      "https://cloudflare-eth.com",
      "https://ethereum-rpc.publicnode.com",
      "https://rpc.ankr.com/eth",
    ],
    privyNetwork: "ethereum",
    aliases: ["ethereum", "eth", "mainnet"],
    relayEnabled: true,
    usdcEnvKey: "ETH_USDC",
    ankrBlockchain: "eth",
  },
  8453: {
    chain: base,
    nativeSymbol: "ETH",
    name: "Base",
    defaultRpcUrls: [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
      "https://base.llamarpc.com",
    ],
    privyNetwork: "base",
    aliases: ["base"],
    relayEnabled: true,
    usdcEnvKey: "BASE_USDC",
    ankrBlockchain: "base",
  },
  137: {
    chain: polygon,
    nativeSymbol: "POL",
    name: "Polygon",
    defaultRpcUrls: [
      "https://polygon-rpc.com",
      "https://polygon-bor-rpc.publicnode.com",
      "https://rpc.ankr.com/polygon",
    ],
    privyNetwork: "polygon",
    aliases: ["polygon", "matic"],
    relayEnabled: true,
    usdcEnvKey: "POLYGON_USDC",
    ankrBlockchain: "polygon",
  },
  42161: {
    chain: arbitrum,
    nativeSymbol: "ETH",
    name: "Arbitrum One",
    defaultRpcUrls: [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-one-rpc.publicnode.com",
      "https://rpc.ankr.com/arbitrum",
    ],
    privyNetwork: "arbitrum",
    aliases: ["arbitrum", "arb", "arbitrum-one"],
    relayEnabled: true,
    usdcEnvKey: "ARB_USDC",
    ankrBlockchain: "arbitrum",
  },
  10: {
    chain: optimism,
    nativeSymbol: "ETH",
    name: "Optimism",
    defaultRpcUrls: [
      "https://mainnet.optimism.io",
      "https://optimism-rpc.publicnode.com",
      "https://rpc.ankr.com/optimism",
    ],
    privyNetwork: "optimism",
    aliases: ["optimism", "op"],
    relayEnabled: true,
    usdcEnvKey: "OP_USDC",
    ankrBlockchain: "optimism",
  },
};

/**
 * Returns the Messari Aave V3 subgraph `market` id for a given reserve token.
 * For Aave V3, the market id is the aToken address (lowercased).
 * Returns null if the chain/token combination is not configured.
 */
export function getAaveMarketId(chainId: number, tokenAddress: Address): string | null {
  const yieldCfg = CHAIN_REGISTRY[chainId]?.yield;
  if (!yieldCfg) return null;
  const stable = yieldCfg.stablecoins.find(
    (s) => s.address.toLowerCase() === tokenAddress.toLowerCase(),
  );
  return stable?.aTokenAddress?.toLowerCase() ?? null;
}

/** Returns the Ankr `blockchain` slug for `ankr_getAccountBalance`, or null if unsupported. */
export function getAnkrBlockchain(chainId: number): string | null {
  return CHAIN_REGISTRY[chainId]?.ankrBlockchain ?? null;
}

export function getYieldConfig(chainId: number): YieldChainConfig | null {
  return CHAIN_REGISTRY[chainId]?.yield ?? null;
}

export function getEnabledYieldChains(): number[] {
  return YIELD_ENV.enabledChainIds.filter((id) => CHAIN_REGISTRY[id]?.yield != null);
}

export function getChainRpcUrls(chainId: number): string[] {
  return CHAIN_REGISTRY[chainId]?.defaultRpcUrls ?? [];
}

/** @deprecated use getChainRpcUrls */
export function getChainRpcUrl(chainId: number): string {
  return getChainRpcUrls(chainId)[0] ?? "";
}

export function getChainObject(chainId: number): Chain | null {
  return CHAIN_REGISTRY[chainId]?.chain ?? null;
}

/** Alias of getChainObject — used by AA-derivation helpers that expect the viem Chain object. */
export function getViemChain(chainId: number): Chain | null {
  return getChainObject(chainId);
}

/** Returns the primary RPC URL for the given chain. Empty string if unknown. */
export function getRpcUrlForChain(chainId: number): string {
  if (chainId === CHAIN_CONFIG.chainId) return CHAIN_CONFIG.rpcUrl;
  return getChainRpcUrls(chainId)[0] ?? "";
}

/**
 * Returns the canonical USDC contract address for the given chain, read from
 * the env var declared in the chain's `usdcEnvKey`. Returns null if either
 * the chain is unknown, the chain has no `usdcEnvKey`, or the env var is
 * unset/empty. Callers (e.g. /send fiat shortcut) decide whether a missing
 * USDC is a hard error.
 */
/**
 * Returns the chain's default block explorer base URL (without trailing slash)
 * sourced from viem's `Chain.blockExplorers.default.url`. Returns null when the
 * chain is unknown or has no default explorer registered.
 */
export function getChainName(chainId: number): string {
  return CHAIN_REGISTRY[chainId]?.name ?? "Unknown";
}

export function getExplorerBaseUrl(chainId: number): string | null {
  const entry = CHAIN_REGISTRY[chainId];
  const url = entry?.chain?.blockExplorers?.default?.url;
  if (!url) return null;
  return url.replace(/\/+$/, "");
}

/**
 * Returns the canonical "view tx on explorer" link for a tx hash on the given
 * chain, or null when no explorer is configured. Centralised here so callers
 * (notifyResolved, future swap/yield UI) never hand-build chain-specific URLs.
 */
export function getExplorerTxUrl(chainId: number, txHash: string): string | null {
  const base = getExplorerBaseUrl(chainId);
  if (!base) return null;
  return `${base}/tx/${txHash}`;
}

export function getUsdcAddress(chainId: number): Address | null {
  const entry = CHAIN_REGISTRY[chainId];
  if (!entry?.usdcEnvKey) return null;
  const raw = process.env[entry.usdcEnvKey]?.trim();
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw as Address;
}

export const CAIP2_BY_PRIVY_NETWORK: Record<string, string> = Object.fromEntries(
  Object.entries(CHAIN_REGISTRY).map(([id, entry]) => [entry.privyNetwork, `eip155:${id}`]),
);

export const RELAY_SUPPORTED_CHAIN_IDS: number[] = Object.entries(CHAIN_REGISTRY)
  .filter(([, entry]) => entry.relayEnabled)
  .map(([id]) => parseInt(id, 10));

/**
 * Resolve a human-typed chain symbol (e.g. "base", "arb", "polygon") to its
 * numeric chain id. Returns the default chain id when `symbol` is omitted.
 * Returns null if the symbol is unknown — callers decide how to surface that.
 */
export function resolveChainSymbol(symbol?: string): number | null {
  if (!symbol) return CHAIN_CONFIG.chainId;
  const needle = symbol.trim().toLowerCase();
  if (!needle) return CHAIN_CONFIG.chainId;
  for (const [id, entry] of Object.entries(CHAIN_REGISTRY)) {
    if (entry.aliases.includes(needle)) return parseInt(id, 10);
    if (entry.name.toLowerCase() === needle) return parseInt(id, 10);
  }
  const asInt = parseInt(needle, 10);
  if (!Number.isNaN(asInt) && CHAIN_REGISTRY[asInt]) return asInt;
  return null;
}

const DEFAULT_CHAIN_ID = 43114;

const chainId = parseInt(process.env.CHAIN_ID ?? String(DEFAULT_CHAIN_ID), 10);
const entry = CHAIN_REGISTRY[chainId] ?? CHAIN_REGISTRY[DEFAULT_CHAIN_ID]!;

const envOverride = process.env.RPC_URL;
const envFallbacks = process.env.RPC_URL_FALLBACKS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

const rpcUrls = envOverride
  ? [envOverride, ...envFallbacks]
  : entry.defaultRpcUrls;

export const CHAIN_CONFIG = {
  chainId,
  chain: entry.chain,
  nativeSymbol: entry.nativeSymbol,
  name: entry.name,
  /** @deprecated Single URL retained for legacy callers. Use `rpcUrls`. */
  rpcUrl: rpcUrls[0]!,
  rpcUrls,
} as const;
