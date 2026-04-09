import { getContract, encodeFunctionData } from "viem";
import type { ISmartAccountService } from "../../../../use-cases/interface/output/blockchain/smartAccount.interface";
import type { ViemClientAdapter } from "./viemClient";

const FACTORY_ABI = [
  {
    name: "createAccount",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ name: "account", type: "address" }],
  },
  {
    name: "getAddress",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export class SmartAccountAdapter implements ISmartAccountService {
  constructor(
    private readonly viemClient: ViemClientAdapter,
    private readonly factoryAddress: string,
    private readonly botAddress: string,
  ) {}

  async getAddress(userId: string): Promise<string> {
    const salt = this.userIdToSalt(userId);
    const address = await this.viemClient.publicClient.readContract({
      address: this.factoryAddress as `0x${string}`,
      abi: FACTORY_ABI,
      functionName: "getAddress",
      args: [this.botAddress as `0x${string}`, salt],
    });
    return address as string;
  }

  async isDeployed(address: string): Promise<boolean> {
    const code = await this.viemClient.publicClient.getCode({
      address: address as `0x${string}`,
    });
    return !!code && code !== "0x";
  }

  async deploy(userId: string): Promise<{ smartAccountAddress: string; txHash: string }> {
    const salt = this.userIdToSalt(userId);

    const smartAccountAddress = await this.getAddress(userId);
    const alreadyDeployed = await this.isDeployed(smartAccountAddress);
    if (alreadyDeployed) {
      return { smartAccountAddress, txHash: "0x0" };
    }

    const callData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "createAccount",
      args: [this.botAddress as `0x${string}`, salt],
    });

    const walletClient = this.viemClient.walletClient;
    if (!walletClient) throw new Error("BOT_PRIVATE_KEY not configured — cannot deploy smart account");
    const txHash = await walletClient.sendTransaction({
      to: this.factoryAddress as `0x${string}`,
      data: callData,
      account: walletClient.account!,
      chain: walletClient.chain,
    });

    await this.viemClient.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { smartAccountAddress, txHash };
  }

  private userIdToSalt(userId: string): bigint {
    // Deterministic salt from userId — hash-like via simple numeric conversion
    let hash = 0n;
    for (let i = 0; i < userId.length; i++) {
      hash = (hash * 31n + BigInt(userId.charCodeAt(i))) % (2n ** 128n);
    }
    return hash;
  }
}
