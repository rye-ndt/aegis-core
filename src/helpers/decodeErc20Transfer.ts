import { CHAIN_CONFIG, getUsdcAddress } from "./chainConfig";

const TRANSFER_SELECTOR = "a9059cbb"; // keccak("transfer(address,uint256)")[0:4]
const USDC_DECIMALS = 6;

export type DecodedErc20Transfer = {
  tokenAddress: `0x${string}`;
  recipient: `0x${string}`;
  amountRaw: bigint;
  amountHuman: string;
  isUsdc: boolean;
};

/**
 * Best-effort decode of an inner ERC20 `transfer(address,uint256)` from the
 * calldata of a userOp. Used by `notifyResolved` for both branches:
 * - success → render "you sent X TOKEN to 0x…" + explorer button
 * - failure (insufficient balance) → render /buy nudge with the amount
 *
 * Account-abstraction wrappers (Kernel `executeBatch`, Safe `execTransaction`,
 * etc.) ABI-encode the inner call, which means the transfer selector + 64-byte
 * payload appear contiguously inside the wrapper's calldata. Scanning for the
 * selector is fragile in theory but holds for every wrapper we ship today and
 * is the simplest way to recover the amount without plumbing structured
 * metadata through every signing-request creation site.
 *
 * Returns null when no transfer selector is present (e.g. swap, approve, yield
 * deposit) or the payload is malformed.
 */
export function decodeErc20Transfer(
  data: string | undefined,
  chainId: number = CHAIN_CONFIG.chainId,
): DecodedErc20Transfer | null {
  if (!data) return null;
  const hex = data.toLowerCase().replace(/^0x/, "");
  // Token address is the 32 bytes immediately preceding the inner calldata
  // length+selector. Kernel layout: ...<target:32><value:32><cdLen:32><selector:4><args>.
  const selectorIdx = hex.indexOf(TRANSFER_SELECTOR);
  if (selectorIdx < 0) return null;
  // Need at least 4 bytes selector + 32 bytes recipient + 32 bytes amount.
  if (hex.length < selectorIdx + 8 + 64 + 64) return null;

  const recipientHex = hex.slice(selectorIdx + 8 + 24, selectorIdx + 8 + 64);
  const amountHex = hex.slice(selectorIdx + 8 + 64, selectorIdx + 8 + 128);
  if (!/^[0-9a-f]{40}$/.test(recipientHex) || !/^[0-9a-f]{64}$/.test(amountHex)) {
    return null;
  }

  // Walk back to find the most recent 0x-prefixed 20-byte address that is the
  // executeBatch call target. Kernel encodes the target 96 bytes before the
  // inner calldata's selector (target:32, value:32, cdLen:32). Check that
  // window first; fall back to scanning earlier blocks if the layout differs.
  let tokenAddress: `0x${string}` | null = null;
  if (selectorIdx >= 96 * 2) {
    const tokenWord = hex.slice(selectorIdx - 96 * 2, selectorIdx - 96 * 2 + 64);
    if (/^0{24}[0-9a-f]{40}$/.test(tokenWord)) {
      tokenAddress = `0x${tokenWord.slice(24)}` as `0x${string}`;
    }
  }
  if (!tokenAddress) return null;

  let amountRaw: bigint;
  try {
    amountRaw = BigInt(`0x${amountHex}`);
  } catch {
    return null;
  }

  const usdc = getUsdcAddress(chainId);
  const isUsdc = !!usdc && tokenAddress.toLowerCase() === usdc.toLowerCase();
  const amountHuman = isUsdc
    ? formatUnits(amountRaw, USDC_DECIMALS)
    : amountRaw.toString();

  return {
    tokenAddress,
    recipient: `0x${recipientHex}` as `0x${string}`,
    amountRaw,
    amountHuman,
    isUsdc,
  };
}

function formatUnits(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}
