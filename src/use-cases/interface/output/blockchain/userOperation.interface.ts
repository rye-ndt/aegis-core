export interface IUserOperation {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymasterAndData: string;
  signature: string;
}

export interface IUserOperationBuilder {
  build(params: {
    smartAccountAddress: string;
    callData: string;
    sessionKey: { privateKey: string; address: string };
    paymaster?: string;
  }): Promise<IUserOperation>;
  submit(userOp: IUserOperation): Promise<{ userOpHash: string }>;
  waitForReceipt(userOpHash: string): Promise<{ txHash: string; success: boolean }>;
}
