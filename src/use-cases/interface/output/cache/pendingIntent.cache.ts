/**
 * Stores a resolved-but-not-yet-executed capability intent keyed by an
 * approval requestId. Written when an Aegis-Guard delegation check forces a
 * mini-app reapproval; read by the http-server's approval handler so the
 * original /send or /swap can be auto-resumed once the user approves.
 *
 * The pairing is intentional: the approval request and the pending intent
 * share a Redis TTL (see `aegisGuardInterceptor.REAPPROVAL_TTL_SECONDS`) and
 * are deleted together when the approval response lands.
 */
export interface PendingIntent {
  /** UUID of the `ApproveRequest` that gates this intent. Lookup key. */
  approvalRequestId: string;
  /** Capability `id` registered in the dispatcher (e.g. `intent_send`, `intent_swap`). */
  capabilityId: string;
  /**
   * Plain-JSON capability params. Already through compile/resolve/disambiguate
   * — the resume path skips collect() and goes straight to `capability.run`.
   */
  params: Record<string, unknown>;
  userId: string;
  channelId: string;
  /** UTC epoch seconds. */
  expiresAt: number;
}

export interface IPendingIntentStore {
  get(approvalRequestId: string): Promise<PendingIntent | null>;
  save(pending: PendingIntent): Promise<void>;
  delete(approvalRequestId: string): Promise<void>;
}
