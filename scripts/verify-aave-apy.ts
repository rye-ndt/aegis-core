/**
 * Verifies our `rayToApy` math against `app.aave.com`.
 *
 * For every enabled yield chain + Aave-supported stablecoin, this script
 * reads `liquidityRate` (ray) directly from the Aave V3 data provider and
 * prints three numbers side-by-side:
 *
 *   - liquidityRateRay      — raw on-chain value
 *   - rateOverRayPct        — `rate / 1e27` interpreted as APR (no compound)
 *   - currentFormulaApyPct  — `(1 + APR/n)^n - 1` (what `rayToApy` returns today)
 *
 * Usage:
 *   npx tsx scripts/verify-aave-apy.ts
 *
 * Compare `currentFormulaApyPct` against the supply APY shown on
 * `app.aave.com` for the same network + asset. Paste the output + a
 * screenshot of the Aave UI into the PR description.
 *
 * Decision gate (per 2026-05-04-yield-fixes-and-auto-rebalance.md §A3):
 *   - currentFormulaApyPct ≈ Aave UI → keep formula, add a confirming
 *     comment in `aaveV3Adapter.ts` linking to this PR.
 *   - rateOverRayPct ≈ Aave UI instead → switch the formula to
 *     `rate / 1e27` and run `scripts/flush-yield-apy-history.ts` to drop
 *     stale ray-EMA history before the next pool scan.
 *   - Neither matches → investigate the per-second-basis interpretation
 *     before changing anything.
 */
import { createPublicClient, fallback, http, type Address } from "viem";
import {
  CHAIN_CONFIG,
  getChainObject,
  getChainRpcUrls,
  getEnabledYieldChains,
  getYieldConfig,
} from "../src/helpers/chainConfig";
import { createLogger } from "../src/helpers/observability/logger";

const log = createLogger("verifyAaveApy");

const RAY = BigInt("1000000000000000000000000000"); // 1e27
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

const DATA_PROVIDER_ABI = [
  {
    name: "getReserveData",
    type: "function" as const,
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "unbacked", type: "uint256" },
      { name: "accruedToTreasuryScaled", type: "uint256" },
      { name: "totalAToken", type: "uint256" },
      { name: "totalStableDebt", type: "uint256" },
      { name: "totalVariableDebt", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "variableBorrowRate", type: "uint256" },
      { name: "stableBorrowRate", type: "uint256" },
      { name: "averageStableBorrowRate", type: "uint256" },
      { name: "liquidityIndex", type: "uint256" },
      { name: "variableBorrowIndex", type: "uint256" },
      { name: "lastUpdateTimestamp", type: "uint40" },
    ],
  },
] as const;

(async () => {
  const chainIds = getEnabledYieldChains();
  if (chainIds.length === 0) {
    log.warn("no enabled yield chains — nothing to verify");
    process.exit(0);
  }

  for (const chainId of chainIds) {
    const cfg = getYieldConfig(chainId);
    if (!cfg?.aave) {
      log.warn({ chainId }, "no aave config for chain — skipping");
      continue;
    }
    const chain = getChainObject(chainId);
    if (!chain) {
      log.warn({ chainId }, "no chain object — skipping");
      continue;
    }
    const rpcUrls =
      chainId === CHAIN_CONFIG.chainId
        ? (CHAIN_CONFIG.rpcUrls as string[])
        : getChainRpcUrls(chainId);

    const client = createPublicClient({
      chain,
      transport: fallback(
        rpcUrls.map((u) => http(u, { timeout: 10_000 })),
        { retryCount: 1 },
      ),
    });

    for (const stable of cfg.stablecoins) {
      try {
        const data = await client.readContract({
          address: cfg.aave.dataProviderAddress,
          abi: DATA_PROVIDER_ABI,
          functionName: "getReserveData",
          args: [stable.address as Address],
        });

        const liquidityRateRay = data[5];
        // No-compound interpretation: rate is already an annualized fraction
        // when divided by 1e27 ("APR-as-ray"). Most Aave UIs show this as
        // the supply APR; the supply APY then layers per-second compounding.
        const rateOverRay = Number(liquidityRateRay) / Number(RAY);
        // Current production formula in `aaveV3Adapter.rayToApy`.
        const currentFormulaApy =
          Math.pow(1 + rateOverRay / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;

        log.info(
          {
            chainId,
            symbol: stable.symbol,
            tokenAddress: stable.address,
            liquidityRateRay: liquidityRateRay.toString(),
            rateOverRayPct: (rateOverRay * 100).toFixed(4),
            currentFormulaApyPct: (currentFormulaApy * 100).toFixed(4),
            note: "Compare both against app.aave.com supply-APY for the same asset. Paste this row into the PR description.",
          },
          "aave-apy-sample",
        );
      } catch (err) {
        log.error({ err, chainId, symbol: stable.symbol }, "sample failed");
      }
    }
  }

  // Reference math for reviewers — derives currentFormulaApy from a
  // hypothetical 4% APR-in-ray so the formula's behavior is greppable.
  const RAY_EXAMPLE = 0.04 * Number(RAY);
  const exampleApy =
    Math.pow(1 + RAY_EXAMPLE / Number(RAY) / SECONDS_PER_YEAR, SECONDS_PER_YEAR) -
    1;
  log.info(
    {
      hypotheticalAprPct: 4,
      currentFormulaApyPct: (exampleApy * 100).toFixed(4),
      noCompoundApyPct: (4).toFixed(4),
    },
    "reference: 4% APR-in-ray under the current rayToApy formula",
  );

  process.exit(0);
})().catch((err) => {
  log.error({ err }, "verify failed");
  process.exit(1);
});
