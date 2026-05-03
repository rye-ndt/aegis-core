import { addressToEmptyAccount, createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createPublicClient, http } from "viem";
import { AA_CONFIG, getAaEntryPoint } from "./aaConfig";
import { getRpcUrlForChain, getViemChain } from "./chainConfig";
import { createLogger } from "./observability/logger";

const log = createLogger("deriveScaAddress");

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 1000;
const cache = new Map<string, { sca: `0x${string}`; expiresAt: number }>();

function cacheGet(key: string): `0x${string}` | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // refresh LRU ordering
  cache.delete(key);
  cache.set(key, entry);
  return entry.sca;
}

function cacheSet(key: string, sca: `0x${string}`): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { sca, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Compute the Kernel V3.1 SCA address that corresponds to a given Privy embedded EOA
 * on a given chain. Pure derivation — no signing, no transactions.
 */
export async function deriveScaAddress(
  eoa: `0x${string}`,
  chainId: number,
): Promise<`0x${string}`> {
  const key = `${chainId}:${eoa.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) {
    log.debug({ choice: "hit", eoa, chainId }, "cache lookup");
    return cached;
  }
  log.debug({ choice: "miss", eoa, chainId }, "cache lookup");

  const chain = getViemChain(chainId);
  if (!chain) {
    throw new Error(`Unknown chainId for SCA derivation: ${chainId}`);
  }
  const rpcUrl = getRpcUrlForChain(chainId);
  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for chainId ${chainId}`);
  }
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
  const entryPoint = getAaEntryPoint();

  const ownerSigner = addressToEmptyAccount(eoa);
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

  const sca = account.address as `0x${string}`;
  cacheSet(key, sca);
  log.debug({ eoa, chainId, sca }, "sca-derived");
  return sca;
}
