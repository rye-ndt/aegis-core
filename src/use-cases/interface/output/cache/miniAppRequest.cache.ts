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
  /**
   * Drop every queued `sign` request for `userId` (records + ZSET queue).
   * Called when a newer user input supersedes the prior dispatch — without
   * this, the mini-app's `findNextPendingSignForUser` poll can still serve a
   * stale request and the FE will pre-flight / sign the wrong calldata
   * (e.g. show an "insufficient balance" pre-flight on the abandoned step).
   *
   * Returns the ids actually removed (caller may want to log them).
   */
  cancelPendingForUser(userId: string): Promise<string[]>;
}
