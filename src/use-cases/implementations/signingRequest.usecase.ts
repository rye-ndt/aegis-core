import { newCurrentUTCEpoch } from '../../helpers/time/dateTime';
import type { ISigningRequestUseCase } from '../interface/input/signingRequest.interface';
import type { ISigningRequestCache } from '../interface/output/cache/signingRequest.cache';

export class SigningRequestUseCaseImpl implements ISigningRequestUseCase {
  constructor(
    private readonly cache: ISigningRequestCache,
    private readonly onResolved: (chatId: number, txHash: string | undefined, rejected: boolean) => void,
  ) {}

  async resolveRequest(params: {
    requestId: string;
    userId: string;
    txHash?: string;
    rejected?: boolean;
  }): Promise<void> {
    const record = await this.cache.findById(params.requestId);
    if (!record) throw new Error('SIGNING_REQUEST_NOT_FOUND');
    if (record.userId !== params.userId) throw new Error('SIGNING_REQUEST_FORBIDDEN');

    const now = newCurrentUTCEpoch();
    if (record.expiresAt <= now) throw new Error('SIGNING_REQUEST_EXPIRED');

    const rejected = params.rejected === true;
    await this.cache.resolve(params.requestId, rejected ? 'rejected' : 'approved', params.txHash);

    this.onResolved(record.chatId, params.txHash, rejected);
  }
}
