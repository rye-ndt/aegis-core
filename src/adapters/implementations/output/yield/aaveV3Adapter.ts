import { createPublicClient, fallback, http, maxUint256, encodeFunctionData, type Address } from "viem";
import type { Chain } from "viem/chains";
import { YIELD_PROTOCOL_ID } from "../../../../helpers/enums/yieldProtocolId.enum";
import type { IYieldProtocolAdapter, PoolStatus, TxStep } from "../../../../use-cases/interface/yield/IYieldProtocolAdapter";

const RAY = BigInt("1000000000000000000000000000"); // 1e27
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

function rayToApy(rayRate: bigint): number {
  // linearise: APY ≈ rate_per_second * seconds_per_year  (accurate for small rates)
  const ratePerSecond = Number(rayRate) / Number(RAY);
  return ratePerSecond * SECONDS_PER_YEAR;
}

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
  {
    name: "getReserveTokensAddresses",
    type: "function" as const,
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
    ],
  },
] as const;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function" as const,
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function" as const,
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const POOL_ABI = [
  {
    name: "supply",
    type: "function" as const,
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    name: "withdraw",
    type: "function" as const,
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export class AaveV3Adapter implements IYieldProtocolAdapter {
  readonly id = YIELD_PROTOCOL_ID.AAVE_V3;

  private readonly client: ReturnType<typeof createPublicClient>;

  constructor(
    readonly chainId: number,
    private readonly poolAddress: Address,
    private readonly dataProviderAddress: Address,
    rpcUrl: string,
    chain: Chain,
    rpcUrls?: string[],
  ) {
    const urls = rpcUrls && rpcUrls.length > 0 ? rpcUrls : [rpcUrl];
    this.client = createPublicClient({
      chain,
      transport: fallback(
        urls.map((u) => http(u, { timeout: 10_000 })),
        { retryCount: 1 },
      ),
    });
  }

  async getPoolStatus(token: Address): Promise<PoolStatus> {
    const data = await this.client.readContract({
      address: this.dataProviderAddress,
      abi: DATA_PROVIDER_ABI,
      functionName: "getReserveData",
      args: [token],
    });

    const totalAToken = data[2];
    const totalVariableDebt = data[4];
    const liquidityRate = data[5];
    const lastUpdateTimestamp = data[11];

    const totalLiquidity = totalAToken;
    const utilization =
      totalLiquidity === 0n ? 0 : Number(totalVariableDebt) / Number(totalLiquidity);
    const liquidityRaw = totalAToken - totalVariableDebt;

    return {
      supplyApy: rayToApy(liquidityRate),
      utilization,
      liquidityRaw: liquidityRaw < 0n ? 0n : liquidityRaw,
      timestamp: Number(lastUpdateTimestamp),
    };
  }

  async buildDepositTx(params: { user: Address; token: Address; amountRaw: bigint }): Promise<TxStep[]> {
    const allowance = await this.client.readContract({
      address: params.token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [params.user, this.poolAddress],
    });

    const steps: TxStep[] = [];

    if (allowance < params.amountRaw) {
      steps.push({
        to: params.token,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [this.poolAddress, params.amountRaw],
        }),
        value: 0n,
      });
    }

    steps.push({
      to: this.poolAddress,
      data: encodeFunctionData({
        abi: POOL_ABI,
        functionName: "supply",
        args: [params.token, params.amountRaw, params.user, 0],
      }),
      value: 0n,
    });

    return steps;
  }

  async buildWithdrawAllTx(params: { user: Address; token: Address }): Promise<TxStep[]> {
    return [
      {
        to: this.poolAddress,
        data: encodeFunctionData({
          abi: POOL_ABI,
          functionName: "withdraw",
          args: [params.token, maxUint256, params.user],
        }),
        value: 0n,
      },
    ];
  }

  async getUserPosition(user: Address, token: Address): Promise<{ balanceRaw: bigint } | null> {
    const addresses = await this.client.readContract({
      address: this.dataProviderAddress,
      abi: DATA_PROVIDER_ABI,
      functionName: "getReserveTokensAddresses",
      args: [token],
    });

    const aTokenAddress = addresses[0];
    const balance = await this.client.readContract({
      address: aTokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [user],
    });

    if (balance === 0n) return null;
    return { balanceRaw: balance };
  }
}
