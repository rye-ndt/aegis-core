import { ZERODEV_MESSAGE_TYPE } from '../../../../helpers/enums/zerodevMessageType.enum';
import {
  Erc20SpendMessageSchema,
  type ZerodevMessage,
} from '../../../../use-cases/interface/output/delegation/zerodevMessage.types';
import type { IDelegationRequestBuilder } from '../../../../use-cases/interface/output/delegation/delegationRequestBuilder.interface';
import { newCurrentUTCEpoch } from '../../../../helpers/time/dateTime';

const DEFAULT_DELEGATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DELEGATION_TTL_SECONDS = parseInt(
  process.env.DELEGATION_TTL_SECONDS ?? String(DEFAULT_DELEGATION_TTL_SECONDS),
  10,
);

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
      validUntil: newCurrentUTCEpoch() + DELEGATION_TTL_SECONDS,
      chainId: opts.chainId,
    });
  }
}
