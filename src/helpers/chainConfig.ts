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
  stablecoins: Array<{ symbol: string; address: Address; decimals: number }>;
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
    yield: {
      stablecoins: [
        {
          symbol: "USDC",
          address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" as Address,
          decimals: 6,
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
  },
};

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

/**
 * Returns the canonical USDC contract address for the given chain, read from
 * the env var declared in the chain's `usdcEnvKey`. Returns null if either
 * the chain is unknown, the chain has no `usdcEnvKey`, or the env var is
 * unset/empty. Callers (e.g. /send fiat shortcut) decide whether a missing
 * USDC is a hard error.
 */
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
