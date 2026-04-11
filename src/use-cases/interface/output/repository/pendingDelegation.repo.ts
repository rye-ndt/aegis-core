import type { ZerodevMessage } from '../delegation/zerodevMessage.types';

export interface IPendingDelegation {
  id: string;
  userId: string;
  zerodevMessage: ZerodevMessage;
  status: 'pending' | 'signed' | 'expired';
  createdAtEpoch: number;
  expiresAtEpoch: number;
}

export interface IPendingDelegationDB {
  create(record: { userId: string; zerodevMessage: ZerodevMessage }): Promise<IPendingDelegation>;
  findLatestByUserId(userId: string): Promise<IPendingDelegation | undefined>;
  markSigned(id: string): Promise<void>;
}
