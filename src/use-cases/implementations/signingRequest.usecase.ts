import { newCurrentUTCEpoch } from '../../helpers/time/dateTime';
import type { ISigningRequestUseCase } from '../interface/input/signingRequest.interface';
import type {
  ISigningRequestCache,
  ResolvedSigningRequest,
  SigningRequestRecord,
} from '../interface/output/cache/signingRequest.cache';

const POLL_INTERVAL_MS = 500;

export class SigningRequestUseCaseImpl implements ISigningRequestUseCase {
  constructor(
    private readonly cache: ISigningRequestCache,
    private readonly onResolved: (chatId: number, txHash: string | undefined, rejected: boolean) => void,
  ) {}

  async create(record: SigningRequestRecord): Promise<void> {
    await this.cache.save(record);
  }

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

  async waitFor(requestId: string, timeoutMs: number): Promise<ResolvedSigningRequest> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = await this.cache.findById(requestId);
      if (!record) return { status: 'expired' };
      if (record.status === 'approved') return { status: 'approved', txHash: record.txHash };
      if (record.status === 'rejected') return { status: 'rejected' };
      if (record.status === 'expired') return { status: 'expired' };
      if (record.expiresAt <= newCurrentUTCEpoch()) return { status: 'expired' };
      await sleep(POLL_INTERVAL_MS);
    }
    return { status: 'expired' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
