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

interface ChainEntry {
  chain: Chain;
  nativeSymbol: string;
  name: string;
  defaultRpcUrl: string;
  privyNetwork: string;
  /** Common short names the user might type: 'base', 'arb', 'polygon'. */
  aliases: string[];
  /** Relay.link supports this chain for quotes/executions. */
  relayEnabled: boolean;
}

const CHAIN_REGISTRY: Record<number, ChainEntry> = {
  43113: {
    chain: avalancheFuji,
    nativeSymbol: "AVAX",
    name: "Avalanche Fuji",
    defaultRpcUrl: "https://api.avax-test.network/ext/bc/C/rpc",
    privyNetwork: "avalanche-fuji",
    aliases: ["fuji", "avalanche-fuji"],
    relayEnabled: false,
  },
  43114: {
    chain: avalanche,
    nativeSymbol: "AVAX",
    name: "Avalanche",
    defaultRpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    privyNetwork: "avalanche",
    aliases: ["avalanche", "avax"],
    relayEnabled: true,
  },
  1: {
    chain: mainnet,
    nativeSymbol: "ETH",
    name: "Ethereum",
    defaultRpcUrl: "https://cloudflare-eth.com",
    privyNetwork: "ethereum",
    aliases: ["ethereum", "eth", "mainnet"],
    relayEnabled: true,
  },
  8453: {
    chain: base,
    nativeSymbol: "ETH",
    name: "Base",
    defaultRpcUrl: "https://mainnet.base.org",
    privyNetwork: "base",
    aliases: ["base"],
    relayEnabled: true,
  },
  137: {
    chain: polygon,
    nativeSymbol: "POL",
    name: "Polygon",
    defaultRpcUrl: "https://polygon-rpc.com",
    privyNetwork: "polygon",
    aliases: ["polygon", "matic"],
    relayEnabled: true,
  },
  42161: {
    chain: arbitrum,
    nativeSymbol: "ETH",
    name: "Arbitrum One",
    defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
    privyNetwork: "arbitrum",
    aliases: ["arbitrum", "arb", "arbitrum-one"],
    relayEnabled: true,
  },
  10: {
    chain: optimism,
    nativeSymbol: "ETH",
    name: "Optimism",
    defaultRpcUrl: "https://mainnet.optimism.io",
    privyNetwork: "optimism",
    aliases: ["optimism", "op"],
    relayEnabled: true,
  },
};

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

const DEFAULT_CHAIN_ID = 43113;

const chainId = parseInt(process.env.CHAIN_ID ?? String(DEFAULT_CHAIN_ID), 10);
const entry = CHAIN_REGISTRY[chainId] ?? CHAIN_REGISTRY[DEFAULT_CHAIN_ID]!;

export const CHAIN_CONFIG = {
  chainId,
  chain: entry.chain,
  nativeSymbol: entry.nativeSymbol,
  name: entry.name,
  rpcUrl: process.env.RPC_URL ?? entry.defaultRpcUrl,
  bundlerUrl: process.env.AVAX_BUNDLER_URL,
  paymasterUrl: process.env.AVAX_PAYMASTER_URL,
} as const;
