import type {
  ResolvedSigningRequest,
  SigningRequestRecord,
} from '../output/cache/signingRequest.cache';

/**
 * Hook fired when a signing request reaches a terminal state. CLIs use this
 * to push a Telegram message back to the user (success / rejection / failure
 * with recovery nudges).
 */
export type SigningResolutionEvent = {
  /** Original signing request id — surfaced to users in support copy on
   * recovery-flow failures (§P0.4) so we can correlate from the chat side. */
  requestId: string;
  chatId: number;
  userId: string;
  txHash?: string;
  rejected: boolean;
  errorCode?: string;
  errorMessage?: string;
  /** Calldata of the failed userOp — used to decode the failed transfer's
   * token + amount when nudging the user into /buy. */
  data?: string;
  to?: string;
  recipientTelegramUserId?: string;
  recipientHandle?: string;
  amountFormatted?: string;
  tokenSymbol?: string;
  /** Forwarded from `SigningRequestRecord.planKind` so the resolved-side
   * UX (notifyResolved) can branch on stock-recovery completions. */
  planKind?: 'recovery';
};

export interface ISigningRequestUseCase {
  resolveRequest(params: {
    requestId: string;
    userId: string;
    txHash?: string;
    rejected?: boolean;
    errorCode?: string;
    errorMessage?: string;
    /** Raw error (viem revert text) for BE logs only — never persisted or
     * shown to the user. Used to surface on-chain revert reasons that the FE
     * interpreter mapped to `errorCode: 'unknown'`. */
    errorRaw?: string;
  }): Promise<void>;

  /**
   * Persist a new pending signing request so the mini app can pick it up
   * via `GET /request/:id`. The mini app signs with the delegated session
   * key and POSTs a response which flows through `resolveRequest`.
   */
  create(record: SigningRequestRecord): Promise<void>;

  /**
   * Block until the signing request identified by `requestId` is resolved
   * (approved / rejected / expired) or `timeoutMs` elapses. Backed by a
   * simple poll of the underlying cache — no pub/sub required.
   */
  waitFor(requestId: string, timeoutMs: number): Promise<ResolvedSigningRequest>;

  /**
   * Cancel every in-flight `waitFor` for the given user — they resolve
   * immediately with `{ status: 'expired' }`. Used by the Telegram input
   * adapter when a user issues a new command while a prior signing flow is
   * still polling: grammy serialises updates, so the new command would hang
   * behind the prior `await waitFor(…)` (which has a 10-minute timeout).
   * Returns the number of cancelled awaits for observability.
   */
  cancelActiveForUser(userId: string): number;
}
