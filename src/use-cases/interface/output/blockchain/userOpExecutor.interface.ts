export interface ExecuteUserOpParams {
  smartAccountAddress: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
}

export interface ExecuteUserOpResult {
  userOpHash: string;
  txHash: string;
}

export interface IUserOpExecutor {
  execute(params: ExecuteUserOpParams): Promise<ExecuteUserOpResult>;
}
