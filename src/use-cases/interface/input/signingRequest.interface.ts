import type {
  ResolvedSigningRequest,
  SigningRequestRecord,
} from '../output/cache/signingRequest.cache';

export interface ISigningRequestUseCase {
  resolveRequest(params: {
    requestId: string;
    userId: string;
    txHash?: string;
    rejected?: boolean;
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
