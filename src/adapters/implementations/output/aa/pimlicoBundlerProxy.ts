import { createLogger } from "../../../../helpers/observability/logger";
import { AA_ENV } from "../../../../helpers/env/aaEnv";
import { getBundlerUrl } from "../../../../helpers/chainConfig";
import type {
  BundlerForwardArgs,
  BundlerForwardResult,
  IBundlerProxy,
} from "../../../../use-cases/interface/output/aa/bundlerProxy.interface";

const log = createLogger("pimlicoBundlerProxy");

/**
 * Pimlico implementation of the `IBundlerProxy` port. Transparent forwarder
 * for ERC-4337 bundler JSON-RPC traffic — owns nothing but the network call
 * to pimlico. No caching, no retries, no body parsing (the body is forwarded
 * byte-for-byte so JSON.parse can't reorder keys or coerce large integers in
 * userOp fields). Auth, body-size cap, and route matching are the HTTP
 * server's responsibility.
 */
export class PimlicoBundlerProxy implements IBundlerProxy {
  async forward(args: BundlerForwardArgs): Promise<BundlerForwardResult> {
    const url = getBundlerUrl(args.chainId);
    if (!url) {
      log.warn(
        { reqId: args.reqId, chainId: args.chainId },
        "no-bundler-configured",
      );
      return { status: 0, body: null, upstreamError: "no-bundler-configured" };
    }

    const start = Date.now();
    log.info(
      {
        reqId: args.reqId,
        chainId: args.chainId,
        method: args.method,
        bodyBytes: args.body.byteLength,
      },
      "bundler-proxy-forward",
    );

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: args.body,
        signal: AbortSignal.timeout(AA_ENV.bundlerRequestTimeoutMs),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = {
        reqId: args.reqId,
        chainId: args.chainId,
        method: args.method,
        status: res.status,
        durationMs: Date.now() - start,
        upstreamBytes: buf.byteLength,
      };
      if (res.status >= 400) log.warn(meta, "bundler-proxy-result");
      else log.info(meta, "bundler-proxy-result");
      return { status: res.status, body: buf };
    } catch (err) {
      // Distinguish timeout from other upstream errors so ops dashboards can
      // alarm on the two separately. AbortSignal.timeout() rejects with an
      // AbortError whose name is "AbortError" or "TimeoutError" depending on
      // the runtime; both indicate we tripped our own 15 s ceiling, not a
      // network/connection error.
      const isError = err instanceof Error;
      const name = isError ? err.name : "UnknownError";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      const reason = timedOut ? "bundler-upstream-timeout" : "bundler-upstream-failed";
      const msg = isError ? `${err.name}: ${err.message}` : String(err);
      log.warn(
        {
          reqId: args.reqId,
          chainId: args.chainId,
          method: args.method,
          durationMs: Date.now() - start,
          timedOut,
          err: msg,
        },
        reason,
      );
      return { status: 0, body: null, upstreamError: timedOut ? "timeout" : msg };
    }
  }
}
