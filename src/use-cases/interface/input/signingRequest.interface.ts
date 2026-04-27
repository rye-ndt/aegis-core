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
};

export interface ISigningRequestUseCase {
  resolveRequest(params: {
    requestId: string;
    userId: string;
    txHash?: string;
    rejected?: boolean;
    errorCode?: string;
    errorMessage?: string;
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
}
