import { newUuid } from '../../helpers/uuid';
import { newCurrentUTCEpoch } from '../../helpers/time/dateTime';
import type { ISigningRequestUseCase } from '../interface/input/signingRequest.interface';
import type { ISigningRequestCache } from '../interface/output/cache/signingRequest.cache';
import type { ISseRegistry } from '../interface/output/sse/sseRegistry.interface';

export class SigningRequestUseCaseImpl implements ISigningRequestUseCase {
  constructor(
    private readonly cache: ISigningRequestCache,
    private readonly sseRegistry: ISseRegistry,
    private readonly onResolved: (chatId: number, txHash: string | undefined, rejected: boolean) => void,
  ) {}

  async createRequest(params: {
    userId: string;
    chatId: number;
    to: string;
    value: string;
    data: string;
    description: string;
    autoSign?: boolean;
  }): Promise<{ requestId: string; pushed: boolean }> {
    const id = newUuid();
    const now = newCurrentUTCEpoch();
    const record = {
      id,
      userId: params.userId,
      chatId: params.chatId,
      to: params.to,
      value: params.value,
      data: params.data,
      description: params.description,
      status: 'pending' as const,
      createdAt: now,
      expiresAt: now + 300,
      autoSign: params.autoSign,
    };

    await this.cache.save(record);

    const pushed = this.sseRegistry.push(params.userId, {
      type: 'sign_request',
      requestId: id,
      to: params.to,
      value: params.value,
      data: params.data,
      description: params.description,
      expiresAt: record.expiresAt,
      autoSign: params.autoSign,
    });

    return { requestId: id, pushed };
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

  async getPendingForUser(userId: string) {
    const record = await this.cache.findPendingByUserId(userId);
    if (!record) return null;
    return {
      requestId: record.id,
      to: record.to,
      value: record.value,
      data: record.data,
      description: record.description,
      expiresAt: record.expiresAt,
      autoSign: record.autoSign,
    };
  }

  async getRequest(requestId: string, userId: string) {
    const record = await this.cache.findById(requestId);
    if (!record || record.userId !== userId) return null;
    return {
      requestId: record.id,
      to: record.to,
      value: record.value,
      data: record.data,
      description: record.description,
      expiresAt: record.expiresAt,
      status: record.status,
      autoSign: record.autoSign,
    };
  }
}
