import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji, avalanche } from "viem/chains";

export class ViemClientAdapter {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly chainId: number;

  constructor(params: {
    rpcUrl: string;
    botPrivateKey: string;
    chainId: number;
  }) {
    this.chainId = params.chainId;
    const chain = params.chainId === 43114 ? avalanche : avalancheFuji;
    const transport = http(params.rpcUrl);

    this.publicClient = createPublicClient({ chain, transport });

    const account = privateKeyToAccount(params.botPrivateKey as `0x${string}`);
    this.walletClient = createWalletClient({ account, chain, transport });
  }
}
