import { createPublicClient, fallback, http, type Chain, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createKernelAccountClient, createKernelAccount, createZeroDevPaymasterClient } from '@zerodev/sdk';
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
    private readonly paymasterUrl?: string,
    rpcUrls?: string[],
  ) {
    const urls = rpcUrls && rpcUrls.length > 0 ? rpcUrls : [rpcUrl];
    this.publicClient = createPublicClient({
      transport: fallback(urls.map((u) => http(u)), { retryCount: 1 }),
      chain,
    });
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

    const paymasterClient = this.paymasterUrl
      ? createZeroDevPaymasterClient({
          chain: this.chain,
          transport: http(this.paymasterUrl),
        })
      : null;

    const kernelClient = createKernelAccountClient({
      account,
      chain: this.chain,
      bundlerTransport: http(this.bundlerUrl),
      ...(paymasterClient && {
        paymaster: {
          getPaymasterData: paymasterClient.getPaymasterData,
          getPaymasterStubData: paymasterClient.getPaymasterStubData,
        },
      }),
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
