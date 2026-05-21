import type { IntentResult } from '../../input/resultCard.types';

// Absent `kind` on a row is treated as `'userop'` — every row written before
// the zero-sign Polymarket rewrite (2026-05-15) lacks the field. New kinds
// must not assume legacy back-compat carve-outs.
export type SigningRequestKind = 'userop' | 'eoa_tx' | 'eip712';

export type Eip712Purpose = 'clob_auth' | 'polymarket_order';

// Mirrors viem's `TypedDataDomain` so the interface layer doesn't import a
// viem type.
export interface SigningRequestTypedDataDomain {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: string;
  salt?: string;
}

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
  kind?: SigningRequestKind;
  purpose?: Eip712Purpose;
  domain?: SigningRequestTypedDataDomain;
  types?: Record<string, Array<{ name: string; type: string }>>;
  primaryType?: string;
  // BigInts must be pre-stringified — JSON serialisation can't carry them.
  message?: Record<string, unknown>;
  // The /response handler refuses an eip712 row if the address recovered from
  // (signature, domain, types, message) doesn't equal `expectedSigner`.
  expectedSigner?: string;
  betId?: string;
  // Set on rows enqueued by the prediction-market setup state machine
  // (gas funding, approvals, clob_auth). `resolveRequest` forwards it on
  // `SigningResolutionEvent` so the BE wrapper can fan out to
  // `notifySetupSignResolved`.
  setupForUserId?: string;
  positionId?: string;
  polymarketOrderId?: string;
  signature?: string;
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
  /**
   * Plain-English preview the mini-app renders inside its existing approve
   * modal in place of the raw to/value/calldata view. Always status="preview"
   * — never carries txHashes or nextActions. Set by capabilities via
   * `buildPreview`; threaded through `Artifact.sign_calldata.preview` →
   * here → `GET /request/:id` → mini-app `ResultCard`. Backwards-compat:
   * when undefined the mini-app falls back to today's raw view.
   */
  preview?: IntentResult;
  /**
   * When true, `notifyResolved` skips the generic "Transaction confirmed" /
   * "Transaction rejected" card on resolution. Used for intermediate steps of
   * multi-step flows (e.g. yield approve → supply, swap approve → swap) where
   * the orchestrating capability emits its own rich result card after the
   * FINAL step. Without this flag the user gets a misleading mid-flow success
   * card after step 1 and assumes the operation is done.
   *
   * Failure cards (insufficient balance / errorCode branches) still fire even
   * when set — those are recoverable user-facing prompts, not generic noise.
   */
  silentResolution?: boolean;
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
    signature?: string,
    polymarketOrderId?: string,
  ): Promise<void>;
  /**
   * Flip every still-`pending` request belonging to `userId` to `expired` and
   * drop them from the per-user index. Used when a newer user input
   * supersedes prior dispatches that left signing requests parked in the FE:
   * any subsequent `/response` for these ids is then rejected by
   * `resolveRequest` so `notifyResolved` does not fire phantom failure cards
   * (e.g. an "insufficient balance" rejection card for a request the user
   * already abandoned).
   *
   * Returns the ids that were actually flipped (caller may want to log them).
   */
  cancelPendingForUser(userId: string): Promise<string[]>;
}

export type ResolvedSigningRequest =
  | { status: 'approved'; txHash?: string }
  | { status: 'rejected'; errorCode?: string; errorMessage?: string }
  | { status: 'expired' };
