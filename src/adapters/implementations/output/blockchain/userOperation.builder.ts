import { encodeFunctionData } from "viem";
import type {
  IUserOperation,
  IUserOperationBuilder,
} from "../../../../use-cases/interface/output/blockchain/userOperation.interface";
import type { ViemClientAdapter } from "./viemClient";

const ENTRY_POINT_ABI = [
  {
    name: "getNonce",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
] as const;

const EXECUTE_WITH_FEE_ABI = [
  {
    name: "executeWithFee",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "feeBps", type: "uint256" },
      { name: "feeRecipient", type: "address" },
    ],
    outputs: [],
  },
] as const;

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

export class UserOperationBuilder implements IUserOperationBuilder {
  constructor(
    private readonly viemClient: ViemClientAdapter,
    private readonly entryPointAddress: string,
    private readonly bundlerUrl: string,
    private readonly botPrivateKey: string,
    private readonly treasuryAddress: string,
    private readonly feeBps: number = 100,
  ) {}

  async build(params: {
    smartAccountAddress: string;
    callData: string;
    sessionKey: { privateKey: string; address: string };
    paymaster?: string;
  }): Promise<IUserOperation> {
    const nonce = await this.viemClient.publicClient.readContract({
      address: this.entryPointAddress as `0x${string}`,
      abi: ENTRY_POINT_ABI,
      functionName: "getNonce",
      args: [params.smartAccountAddress as `0x${string}`, 0n],
    });

    const callDataWithFee = encodeFunctionData({
      abi: EXECUTE_WITH_FEE_ABI,
      functionName: "executeWithFee",
      args: [
        params.smartAccountAddress as `0x${string}`,
        0n,
        params.callData as `0x${string}`,
        BigInt(this.feeBps),
        this.treasuryAddress as `0x${string}`,
      ],
    });

    const gasPrice = await this.viemClient.publicClient.getGasPrice();

    const userOp: IUserOperation = {
      sender: params.smartAccountAddress,
      nonce: (nonce as bigint).toString(),
      initCode: "0x",
      callData: callDataWithFee,
      callGasLimit: "200000",
      verificationGasLimit: "100000",
      preVerificationGas: "50000",
      maxFeePerGas: gasPrice.toString(),
      maxPriorityFeePerGas: (gasPrice / 2n).toString(),
      paymasterAndData: params.paymaster ?? "0x",
      signature: "0x",
    };

    return userOp;
  }

  async submit(userOp: IUserOperation): Promise<{ userOpHash: string }> {
    const response = await fetch(this.bundlerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendUserOperation",
        params: [userOp, this.entryPointAddress],
      }),
    });
    const data = await response.json() as { result?: string; error?: { message: string } };
    if (data.error) throw new Error(`Bundler error: ${data.error.message}`);
    return { userOpHash: data.result! };
  }

  async waitForReceipt(userOpHash: string): Promise<{ txHash: string; success: boolean }> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const response = await fetch(this.bundlerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getUserOperationReceipt",
          params: [userOpHash],
        }),
      });
      const data = await response.json() as {
        result?: { receipt: { transactionHash: string }; success: boolean } | null;
      };
      if (data.result) {
        return {
          txHash: data.result.receipt.transactionHash,
          success: data.result.success,
        };
      }
    }
    throw new Error(`UserOperation receipt timed out after ${POLL_TIMEOUT_MS}ms`);
  }
}
