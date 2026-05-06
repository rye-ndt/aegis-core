import { ASTER_DIAMOND_DEFAULT_BSC } from "../chainConfig";
import { createLogger } from "../observability/logger";

const log = createLogger("asterEnv");

const rawDiamond = (
  process.env.ASTER_DIAMOND_ADDRESS_BSC ?? ASTER_DIAMOND_DEFAULT_BSC
).trim() as `0x${string}`;

if (!/^0x[0-9a-fA-F]{40}$/.test(rawDiamond)) {
  log.error(
    { value: rawDiamond },
    "ASTER_DIAMOND_ADDRESS_BSC malformed",
  );
  throw new Error(
    "ASTER_DIAMOND_ADDRESS_BSC must be a 0x-prefixed 20-byte hex string",
  );
}

const positionsTtlSec = Number(process.env.ASTER_POSITIONS_TTL_SEC ?? 60);
const priceTtlSec = Number(process.env.ASTER_PRICE_TTL_SEC ?? 15);
if (!Number.isFinite(positionsTtlSec) || positionsTtlSec <= 0) {
  throw new Error("ASTER_POSITIONS_TTL_SEC must be a positive number");
}
if (!Number.isFinite(priceTtlSec) || priceTtlSec <= 0) {
  throw new Error("ASTER_PRICE_TTL_SEC must be a positive number");
}

let brokerId: bigint;
try {
  brokerId = BigInt(process.env.ASTER_BROKER_ID ?? "0");
} catch {
  throw new Error("ASTER_BROKER_ID must be a uint integer string");
}

// §P1.2 — slippage/dust haircut on the bridged collateral before the venue
// open leg. Default 100 bps (1%) so realistic Relay slippage doesn't revert
// `transferFrom(amountIn)` when delivered USDC.bsc < quoted expectedOut. The
// remainder is recovered by the existing post-close return-swap path.
const openSlippageBps = Number(process.env.ASTER_OPEN_SLIPPAGE_BPS ?? 100);
if (
  !Number.isFinite(openSlippageBps) ||
  openSlippageBps < 0 ||
  openSlippageBps >= 10_000
) {
  throw new Error(
    "ASTER_OPEN_SLIPPAGE_BPS must be a non-negative integer < 10000",
  );
}

export const ASTER_ENV = {
  diamondAddressBsc: rawDiamond.toLowerCase() as `0x${string}`,
  brokerId,
  positionsTtlSec,
  priceTtlSec,
  recoveryEnabled: (process.env.STOCK_RECOVERY_ENABLED ?? "true") === "true",
  bscRpcUrl: process.env.BSC_RPC_URL?.trim() || undefined,
  openSlippageBps,
} as const;
