import type { MiniAppRequest } from './miniAppRequest.types';

export interface IMiniAppRequestCache {
  store(request: MiniAppRequest): Promise<void>;
  retrieve(requestId: string): Promise<MiniAppRequest | null>;
  delete(requestId: string): Promise<void>;
  /**
   * Return the oldest un-resolved `SignRequest` for the given user, or null.
   * Used by the mini-app step-chaining flow: after signing step N, the
   * FE polls this to fetch step N+1 without closing the WebApp window.
   */
  findNextPendingSignForUser(userId: string): Promise<MiniAppRequest | null>;
}
