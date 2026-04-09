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
  readonly walletClient: WalletClient | null;
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

    const isValidKey = /^(0x)?[0-9a-fA-F]{64}$/.test(params.botPrivateKey.trim());
    if (isValidKey) {
      const key = params.botPrivateKey.trim();
      const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
      this.walletClient = createWalletClient({ account, chain, transport });
    } else {
      this.walletClient = null;
    }
  }
}
