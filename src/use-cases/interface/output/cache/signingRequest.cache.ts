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
  // Stable classification produced by the FE's `interpretSignError` and
  // surfaced via `resolveRequest`. Persisted on the record so capabilities
  // that `waitFor` a step can branch on it (e.g. stock recovery flow).
  errorCode?: string;
  errorMessage?: string;
  /**
   * Optional classification used by `notifyResolved` to branch the success
   * UX. The stock recovery flow sets `"recovery"` so the resolved leg shows
   * "Funds returned" instead of a generic "transaction submitted".
   */
  planKind?: 'recovery';
};

export interface ISigningRequestCache {
  save(record: SigningRequestRecord): Promise<void>;
  findById(id: string): Promise<SigningRequestRecord | null>;
  resolve(
    id: string,
    status: 'approved' | 'rejected',
    txHash?: string,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void>;
}

export type ResolvedSigningRequest =
  | { status: 'approved'; txHash?: string }
  | { status: 'rejected'; errorCode?: string; errorMessage?: string }
  | { status: 'expired' };
