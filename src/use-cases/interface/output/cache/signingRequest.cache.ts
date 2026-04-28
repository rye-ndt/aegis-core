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
  recipientTelegramUserId?: string;
  recipientHandle?: string;
  amountFormatted?: string;
  tokenSymbol?: string;
  // When set on a non-rejected resolution, signingRequest.usecase bumps
  // token_delegations.spent_raw so the FE permissions bar reflects autosigned
  // spend. Only attribute on the FINAL step of multi-step flows to avoid
  // double-counting (approve + swap, approve + deposit).
  tokenAddress?: string;
  amountRaw?: string;
};

export interface ISigningRequestCache {
  save(record: SigningRequestRecord): Promise<void>;
  findById(id: string): Promise<SigningRequestRecord | null>;
  resolve(id: string, status: 'approved' | 'rejected', txHash?: string): Promise<void>;
}

export type ResolvedSigningRequest =
  | { status: 'approved'; txHash?: string }
  | { status: 'rejected' }
  | { status: 'expired' };
