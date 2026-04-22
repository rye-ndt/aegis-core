export type SigningRequestRecord = {
  id: string;
  userId: string;
  chatId: number;
  to: string;
  value: string;
  data: string;
  description: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  txHash?: string;
  createdAt: number;
  expiresAt: number;
  autoSign?: boolean;
};

export interface ISigningRequestCache {
  save(record: SigningRequestRecord): Promise<void>;
  findById(id: string): Promise<SigningRequestRecord | null>;
  resolve(id: string, status: 'approved' | 'rejected', txHash?: string): Promise<void>;
  findPendingByUserId(userId: string): Promise<SigningRequestRecord | null>;
}
