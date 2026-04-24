import {
  createPublicClient,
  fallback,
  http,
  type PublicClient,
} from "viem";
import type { Chain } from "viem/chains";
import type { IChainReader } from "../../../../use-cases/interface/output/blockchain/chainReader.interface";

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export class ViemClientAdapter implements IChainReader {
  readonly publicClient: PublicClient;
  readonly chainId: number;

  constructor(params: {
    rpcUrl: string;
    rpcUrls?: string[];
    chainId: number;
    chain: Chain;
  }) {
    this.chainId = params.chainId;
    const urls = params.rpcUrls && params.rpcUrls.length > 0 ? params.rpcUrls : [params.rpcUrl];
    const transport = fallback(
      urls.map((url) => http(url, { timeout: 10_000 })),
      { rank: false, retryCount: 1 },
    );

    this.publicClient = createPublicClient({ chain: params.chain, transport });
  }

  getNativeBalance(address: `0x${string}`): Promise<bigint> {
    return this.publicClient.getBalance({ address });
  }

  getErc20Balance(tokenAddress: `0x${string}`, account: `0x${string}`): Promise<bigint> {
    return this.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [account],
    }) as Promise<bigint>;
  }
}
