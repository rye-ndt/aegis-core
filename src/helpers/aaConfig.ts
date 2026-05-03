import { entryPoint07Address } from "viem/account-abstraction";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";

export const AA_CONFIG = {
  entryPointVersion: "0.7" as const,
  entryPointAddress: entryPoint07Address,
  kernelVersion: KERNEL_V3_1,
  // Pinned to 0n to match Privy's hosted smart-wallets default for Kernel V3.1.
  // Changing this constant changes every NEW user's SCA. Existing users are pinned in DB
  // and unaffected; the safety net is the DB-canonical read in resolverEngine.
  index: 0n,
} as const;

export function getAaEntryPoint() {
  return getEntryPoint(AA_CONFIG.entryPointVersion);
}
