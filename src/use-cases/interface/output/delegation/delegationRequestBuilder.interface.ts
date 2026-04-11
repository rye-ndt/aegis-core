import type { ZerodevMessage } from './zerodevMessage.types';

export interface IDelegationRequestBuilder {
  buildErc20Spend(opts: {
    sessionKeyAddress: string;
    target: string;      // ERC20 contract address — mirrors Permission.target
    valueLimit: string;  // BigInt decimal string — mirrors ConditionValue.value
    chainId: number;
  }): ZerodevMessage;
}
