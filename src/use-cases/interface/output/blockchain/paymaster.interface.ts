import type { IUserOperation } from "./userOperation.interface";

export interface IPaymasterService {
  sponsorUserOperation(userOp: IUserOperation): Promise<{ paymasterAndData: string }>;
}
