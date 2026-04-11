import { ZERODEV_MESSAGE_TYPE } from '../../../../helpers/enums/zerodevMessageType.enum';
import {
  Erc20SpendMessageSchema,
  type ZerodevMessage,
} from '../../../../use-cases/interface/output/delegation/zerodevMessage.types';
import type { IDelegationRequestBuilder } from '../../../../use-cases/interface/output/delegation/delegationRequestBuilder.interface';

export class DelegationRequestBuilder implements IDelegationRequestBuilder {
  buildErc20Spend(opts: {
    sessionKeyAddress: string;
    target: string;
    valueLimit: string;
    chainId: number;
  }): ZerodevMessage {
    return Erc20SpendMessageSchema.parse({
      type: ZERODEV_MESSAGE_TYPE.ERC20_SPEND,
      sessionKeyAddress: opts.sessionKeyAddress,
      target: opts.target,
      valueLimit: opts.valueLimit,
      validUntil:
        Math.floor(Date.now() / 1000) +
        parseInt(process.env.DELEGATION_TTL_SECONDS ?? '604800', 10),
      chainId: opts.chainId,
    });
  }
}
