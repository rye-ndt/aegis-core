/**
 * Thrown when an external provider does not support the requested chain. The
 * HTTP layer maps this to 400; agent tools surface a chain-not-supported
 * message rather than retrying.
 */
export class UnsupportedChainError extends Error {
  readonly chainId: number;

  constructor(chainId: number, message?: string) {
    super(message ?? `Chain ${chainId} is not supported by this provider`);
    this.name = "UnsupportedChainError";
    this.chainId = chainId;
  }
}

export function isUnsupportedChainError(err: unknown): err is UnsupportedChainError {
  return err instanceof UnsupportedChainError ||
    (err instanceof Error && err.name === "UnsupportedChainError");
}
