/**
 * Provider-side rate-limit signal. Thrown by cache decorators / external
 * adapters when a per-user or global quota is exhausted. HTTP layer maps this
 * to 429; agent tools map it to a graceful "try again" message.
 *
 * `retryAfterSec` is advisory — callers may surface it to the client as a
 * Retry-After hint, but the value is a heuristic, not a contract.
 */
export class RateLimitedError extends Error {
  readonly retryAfterSec: number;

  constructor(message: string, retryAfterSec = 60) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterSec = retryAfterSec;
  }
}

/** True when `err` is a rate-limit signal regardless of cross-realm prototype. */
export function isRateLimitedError(err: unknown): err is RateLimitedError {
  return err instanceof RateLimitedError ||
    (err instanceof Error && err.name === "RateLimitedError");
}
