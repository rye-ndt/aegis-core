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
}

const CHAIN_REGISTRY: Record<number, ChainEntry> = {
  43113: {
    chain: avalancheFuji,
    nativeSymbol: "AVAX",
    name: "Avalanche Fuji",
    defaultRpcUrl: "https://api.avax-test.network/ext/bc/C/rpc",
    privyNetwork: "avalanche-fuji",
  },
  43114: {
    chain: avalanche,
    nativeSymbol: "AVAX",
    name: "Avalanche",
    defaultRpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    privyNetwork: "avalanche",
  },
  1: {
    chain: mainnet,
    nativeSymbol: "ETH",
    name: "Ethereum",
    defaultRpcUrl: "https://cloudflare-eth.com",
    privyNetwork: "ethereum",
  },
  8453: {
    chain: base,
    nativeSymbol: "ETH",
    name: "Base",
    defaultRpcUrl: "https://mainnet.base.org",
    privyNetwork: "base",
  },
  137: {
    chain: polygon,
    nativeSymbol: "POL",
    name: "Polygon",
    defaultRpcUrl: "https://polygon-rpc.com",
    privyNetwork: "polygon",
  },
  42161: {
    chain: arbitrum,
    nativeSymbol: "ETH",
    name: "Arbitrum One",
    defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
    privyNetwork: "arbitrum",
  },
  10: {
    chain: optimism,
    nativeSymbol: "ETH",
    name: "Optimism",
    defaultRpcUrl: "https://mainnet.optimism.io",
    privyNetwork: "optimism",
  },
};

export const CAIP2_BY_PRIVY_NETWORK: Record<string, string> = Object.fromEntries(
  Object.entries(CHAIN_REGISTRY).map(([id, entry]) => [entry.privyNetwork, `eip155:${id}`]),
);

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
