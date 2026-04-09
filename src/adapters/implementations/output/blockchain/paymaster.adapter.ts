import type { IPaymasterService } from "../../../../use-cases/interface/output/blockchain/paymaster.interface";
import type { IUserOperation } from "../../../../use-cases/interface/output/blockchain/userOperation.interface";

export class PaymasterAdapter implements IPaymasterService {
  constructor(
    private readonly paymasterUrl: string,
    private readonly entryPointAddress: string,
  ) {}

  async sponsorUserOperation(userOp: IUserOperation): Promise<{ paymasterAndData: string }> {
    const response = await fetch(this.paymasterUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "pm_sponsorUserOperation",
        params: [userOp, { entryPoint: this.entryPointAddress }],
      }),
    });
    const data = await response.json() as {
      result?: { paymasterAndData: string };
      error?: { message: string };
    };
    if (data.error) throw new Error(`Paymaster error: ${data.error.message}`);
    return { paymasterAndData: data.result!.paymasterAndData };
  }
}
