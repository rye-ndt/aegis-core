import { encodeFunctionData } from "viem";
import type {
  ISessionKeyService,
  SessionKeyScope,
} from "../../../../use-cases/interface/output/blockchain/sessionKey.interface";
import type { ViemClientAdapter } from "./viemClient";

const SESSION_KEY_MANAGER_ABI = [
  {
    name: "grantSessionKey",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "sessionKey", type: "address" },
      { name: "expiresAt", type: "uint256" },
      { name: "maxAmountPerTx", type: "uint256" },
      { name: "allowedTokens", type: "address[]" },
    ],
    outputs: [],
  },
  {
    name: "revokeSessionKey",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "sessionKey", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "isValidSessionKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "sessionKey", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export class SessionKeyAdapter implements ISessionKeyService {
  constructor(
    private readonly viemClient: ViemClientAdapter,
    private readonly sessionKeyManagerAddress: string,
    private readonly sessionKeyAddress: string,
  ) {}

  async grant(params: {
    smartAccountAddress: string;
    scope: SessionKeyScope;
  }): Promise<{ sessionKeyAddress: string; txHash: string }> {
    const maxAmountWei = BigInt(Math.floor(params.scope.maxAmountPerTxUsd * 1e6));

    const callData = encodeFunctionData({
      abi: SESSION_KEY_MANAGER_ABI,
      functionName: "grantSessionKey",
      args: [
        params.smartAccountAddress as `0x${string}`,
        this.sessionKeyAddress as `0x${string}`,
        BigInt(params.scope.expiresAtEpoch),
        maxAmountWei,
        params.scope.allowedTokenAddresses as `0x${string}`[],
      ],
    });

    const walletClient = this.viemClient.walletClient;
    if (!walletClient) throw new Error("BOT_PRIVATE_KEY not configured — cannot grant session key");
    const txHash = await walletClient.sendTransaction({
      to: this.sessionKeyManagerAddress as `0x${string}`,
      data: callData,
      account: walletClient.account!,
      chain: walletClient.chain,
    });

    await this.viemClient.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { sessionKeyAddress: this.sessionKeyAddress, txHash };
  }

  async revoke(
    smartAccountAddress: string,
    sessionKeyAddress: string,
  ): Promise<{ txHash: string }> {
    const callData = encodeFunctionData({
      abi: SESSION_KEY_MANAGER_ABI,
      functionName: "revokeSessionKey",
      args: [
        smartAccountAddress as `0x${string}`,
        sessionKeyAddress as `0x${string}`,
      ],
    });

    const walletClient2 = this.viemClient.walletClient;
    if (!walletClient2) throw new Error("BOT_PRIVATE_KEY not configured — cannot revoke session key");
    const txHash = await walletClient2.sendTransaction({
      to: this.sessionKeyManagerAddress as `0x${string}`,
      data: callData,
      account: walletClient2.account!,
      chain: walletClient2.chain,
    });

    await this.viemClient.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash };
  }

  async isValid(smartAccountAddress: string, sessionKeyAddress: string): Promise<boolean> {
    const result = await this.viemClient.publicClient.readContract({
      address: this.sessionKeyManagerAddress as `0x${string}`,
      abi: SESSION_KEY_MANAGER_ABI,
      functionName: "isValidSessionKey",
      args: [smartAccountAddress as `0x${string}`, sessionKeyAddress as `0x${string}`],
    });
    return result as boolean;
  }
}
