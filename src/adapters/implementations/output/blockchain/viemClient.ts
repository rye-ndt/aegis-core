import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
  readonly walletClient: WalletClient | null;
  readonly chainId: number;

  constructor(params: {
    rpcUrl: string;
    botPrivateKey: string;
    chainId: number;
    chain: Chain;
  }) {
    this.chainId = params.chainId;
    const transport = http(params.rpcUrl);

    this.publicClient = createPublicClient({ chain: params.chain, transport });

    const isValidKey = /^(0x)?[0-9a-fA-F]{64}$/.test(params.botPrivateKey.trim());
    if (isValidKey) {
      const key = params.botPrivateKey.trim();
      const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
      this.walletClient = createWalletClient({ account, chain: params.chain, transport });
    } else {
      this.walletClient = null;
    }
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
