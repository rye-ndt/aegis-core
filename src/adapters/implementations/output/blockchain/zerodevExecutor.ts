import { createPublicClient, http, type Chain, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createKernelAccountClient, createKernelAccount } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants';
import { toPermissionValidator } from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { toSudoPolicy } from '@zerodev/permissions/policies';
import type {
  IUserOpExecutor,
  ExecuteUserOpParams,
  ExecuteUserOpResult,
} from '../../../../use-cases/interface/output/blockchain/userOpExecutor.interface';

const ENTRY_POINT = getEntryPoint('0.7');

export class ZerodevUserOpExecutor implements IUserOpExecutor {
  private readonly publicClient: PublicClient;

  constructor(
    private readonly botPrivateKey: Hex,
    private readonly bundlerUrl: string,
    rpcUrl: string,
    private readonly chain: Chain,
  ) {
    this.publicClient = createPublicClient({ transport: http(rpcUrl), chain });
  }

  async execute(params: ExecuteUserOpParams): Promise<ExecuteUserOpResult> {
    const sessionKeySigner = privateKeyToAccount(this.botPrivateKey);
    const ecdsaSigner = await toECDSASigner({ signer: sessionKeySigner });

    const permissionPlugin = await toPermissionValidator(this.publicClient, {
      entryPoint: ENTRY_POINT,
      signer: ecdsaSigner,
      policies: [toSudoPolicy({})],
      kernelVersion: KERNEL_V3_1,
    });

    const account = await createKernelAccount(this.publicClient, {
      plugins: { regular: permissionPlugin },
      entryPoint: ENTRY_POINT,
      kernelVersion: KERNEL_V3_1,
      address: params.smartAccountAddress,
    });

    const kernelClient = createKernelAccountClient({
      account,
      chain: this.chain,
      bundlerTransport: http(this.bundlerUrl),
    });

    const callData = await account.encodeCalls([{
      to: params.to,
      data: params.data,
      value: BigInt(params.value || '0'),
    }]);

    const userOpHash = await kernelClient.sendUserOperation({ callData });
    const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });

    return { userOpHash, txHash: receipt.receipt.transactionHash };
  }
}
