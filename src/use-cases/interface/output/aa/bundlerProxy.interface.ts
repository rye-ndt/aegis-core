/**
 * ERC-4337 bundler proxy port. Forwards JSON-RPC bodies (e.g.
 * `eth_sendUserOperation`, `eth_estimateUserOperationGas`) to a per-chain
 * upstream bundler and passes the response back byte-for-byte. Keeps input
 * adapters (HTTP server) independent of any specific bundler provider — swap
 * pimlico for a self-hosted bundler or stackup by implementing this port.
 */

export interface BundlerForwardArgs {
  chainId: number;
  /** Raw JSON-RPC request body. Implementations must forward these bytes
   *  verbatim — no JSON.parse/stringify round-trip, which would reorder keys
   *  and coerce big-int userOp fields like `nonce` / `callGasLimit`. */
  body: Buffer;
  reqId: string;
  userId: string;
  /** Best-effort method label parsed from the body, for logging only. */
  method: string | undefined;
}

export interface BundlerForwardResult {
  /** HTTP status from the upstream bundler, or 0 when the call threw without
   *  producing a response (timeout, connection refused, missing config). */
  status: number;
  body: Buffer | null;
  /** Set when status is 0. Sentinel values the route maps to specific HTTP
   *  statuses: `"no-bundler-configured"` → 503, `"timeout"` → 504; anything
   *  else → 502. */
  upstreamError?: string;
}

export interface IBundlerProxy {
  forward(args: BundlerForwardArgs): Promise<BundlerForwardResult>;
}
