# AA Bundler Proxy — Backend

Date: 2026-05-15
Status: plan
Pair: see `fe/privy-auth/constructions/2026-05-15-bundler-proxy-fe.md`. The BE plan ships first and is deployable on its own (FE switches to it on a later deploy).

## Why

ERC-4337 `eth_sendUserOperation` calls from the Telegram mini-app to `api.pimlico.io` fail with `TypeError: Load failed` inside Telegram Desktop's macOS WKWebView whenever the request body crosses roughly 8 KB. The same fetch transport, same host, and same API key succeed in the same session for `pm_getPaymasterStubData`, `pm_getPaymasterData`, and `eth_estimateUserOperationGas` (all smaller bodies, or estimate uses dummy signatures). Diagnostic capture:

```
rpc-fetch-threw {kind:"bundler", method:"eth_sendUserOperation",
  bodyBytes:8719, durationMs:7, name:"TypeError", message:"Load failed"}
```

WKWebView returns no `cause` and no `Response`, so the failure is unrecoverable from the FE side. Fix: have the FE POST to our own backend, and the backend forwards the JSON-RPC body to pimlico over Node's `fetch`. Side benefits:

- The pimlico API key leaves the FE bundle (currently shipped to every client and visible in DevTools).
- No CORS preflight on the bundler path (FE is same-origin to BE).
- The bundler URL/key can be rotated without a new FE build.
- We get a server-side log of every userOp the FE attempted to broadcast.

Paymaster calls (`pm_*`) stay direct from FE → pimlico for now. They are small bodies and currently work. Re-evaluate after the bundler proxy ships.

## Scope (in / out)

In scope:

- New BE route `POST /aa/bundler/:chainId` that forwards an arbitrary JSON-RPC body to the chain's pimlico bundler URL.
- Privy-token auth on the new route (same as `POST /response`).
- Chain-agnostic config: bundler URLs come from `chainConfig.ts`, sourced from env per-chain.
- Body-size cap, request timeout, structured logging.
- `.env.example` entries.

Out of scope:

- Paymaster proxying. The paymaster path stays direct FE → pimlico in this change.
- A new logical bundler abstraction (e.g. swapping in another provider). The proxy is a transparent pass-through.
- Caching, retries, batching. Pimlico's own behavior is preserved 1:1.
- Per-user rate limiting beyond what the API key already enforces.

## Files changed

- `be/src/use-cases/interface/output/aa/bundlerProxy.interface.ts` *(new)* — port. `IBundlerProxy { forward(args): Promise<BundlerForwardResult> }`. Keeps the HTTP server independent of any specific bundler vendor; swapping pimlico for stackup/self-hosted is a DI swap.
- `be/src/helpers/env/aaEnv.ts` *(new)* — reads `PIMLICO_BUNDLER_URL_<chainId>` per supported chain; exposes env-overridable `AA_BUNDLER_TIMEOUT_MS` and `AA_BUNDLER_MAX_BODY_BYTES` with bounded fallbacks. Centralised so adapters/routes don't reach into `process.env` directly.
- `be/src/helpers/chainConfig.ts` — add `getBundlerUrl(chainId): string | null` that pulls from `aaEnv`. Mirrors the pattern of `getUsdcAddress(chainId)`. No new fields on `ChainEntry`; the env-driven helper keeps the registry static.
- `be/src/adapters/implementations/output/aa/pimlicoBundlerProxy.ts` *(new)* — concrete implementation of `IBundlerProxy`. The only network-touching piece: `forward(args)` over Node `fetch`. Pure adapter; no http-server dependency, easy to unit-test.
- `be/src/adapters/implementations/input/http/httpServer.ts` — wire `POST /aa/bundler/:chainId` into the existing route table. Reads body, runs Privy auth, delegates to the `IBundlerProxy`, writes status + body verbatim.
- `be/src/adapters/inject/*.di.ts` — instantiate `PimlicoBundlerProxy` and pass it as `IBundlerProxy` into `HttpServer`. Match the existing DI shape.
- `be/.env.example` — document the new env keys.

No domain or use-case changes. No DB / drizzle migration. No new packages.

## Route contract

Path: `POST /aa/bundler/:chainId`
Headers: `Content-Type: application/json`, `Authorization: Bearer <privyToken>` (or `privyToken` field in body — see auth).
Body: a JSON-RPC 2.0 object exactly as viem's HTTP transport would produce it (`{ jsonrpc, id, method, params }`) or a batch array of such.
Response: pimlico's response, **status code and body byte-for-byte unchanged**. We do not rewrap into our usual `{ error }` envelope — viem must see the JSON-RPC error shape it expects.

Path param `chainId` MUST match the chain in the userOp. We don't introspect the body; the FE is responsible for hitting the correct chain endpoint. Unknown chainId → 404. No bundler configured for that chainId → 503 (operational error — surfaces in monitoring without looking like a client bug).

### Auth

Privy-token gate, identical to `POST /response`:

- Accept the token via `Authorization: Bearer <token>` header (preferred — keeps the bundler body purely JSON-RPC and avoids any chance of the token leaking into pimlico-side request logs).
- Resolve to `userId` via `this.authUseCase.resolveUserId(token)`.
- 401 on missing/invalid token. No `userId → SCA` cross-check: the bundler doesn't accept arbitrary calls anyway (paymaster verifies the userOp), and we'd have to parse the body to extract `sender`. Skipping this keeps the proxy stateless and dumb. Document the choice.

### Body validation

- Reject `Content-Length` > **256 KB**. Pimlico's hard limit is higher but no legitimate userOp comes close; this is a cheap DoS bound. Return 413.
- Reject non-JSON bodies (parse error → 400). We don't need to validate JSON-RPC shape — pimlico does that and returns its standard error, which the FE already knows how to surface.

### Forwarding

- Use Node's built-in `fetch` (Node 20+, already in use).
- `POST` to `getBundlerUrl(chainId)` with the **exact request body bytes**. Do *not* `JSON.parse` then re-`JSON.stringify` — preserving bytes avoids reordering keys or losing precision on large integers that JSON.parse would coerce.
- Forward only `Content-Type: application/json`. Strip every other inbound header. Strip every outbound `Cookie`, `Authorization`, anything pimlico might echo back into logs.
- Timeout via `AbortSignal.timeout(15_000)`. 15s is generous — pimlico itself usually responds in <1s; this covers slow-network retries.
- On `fetch` throw / abort: return 502 with `{ error: "bundler-upstream-failed" }`. Log at `warn` with the underlying error.
- On non-2xx from pimlico: pass through status + body unchanged. Log at `warn` so dashboards can alarm on bundler 4xx/5xx rates without parsing FE logs.

### Logging

Logger scope: `pimlicoBundlerProxy` (adapter) + `httpServer` (route entry).

Per request:

- Route entry — existing `request received` line covers method/path/reqId.
- After parse — `log.info({ reqId, userId, chainId, method, bodyBytes }, "bundler-proxy-forward")`. `method` parsed from the body's `method` field (best-effort, `?` if missing or batch).
- After upstream response — `log.info({ reqId, userId, chainId, method, status, durationMs, upstreamBytes }, "bundler-proxy-result")`. At `warn` when `status >= 400` or on throw.

Never log the request or response body. The body carries the userOp signature; a request-id flag like `bodyBytes` is sufficient for correlation. If we ever need to debug a specific failure we can re-enable body capture behind a debug env flag.

## Implementation steps

Order is deploy-safe: BE can ship without touching the FE, and the FE switchover comes later. Each step has clear acceptance.

### Step 1 — Env plumbing (`be/src/helpers/env/aaEnv.ts`)

```ts
const KEY_PREFIX = "PIMLICO_BUNDLER_URL_";

export function readBundlerUrl(chainId: number): string | null {
  const raw = process.env[`${KEY_PREFIX}${chainId}`]?.trim();
  if (!raw) return null;
  try {
    // Validate at boot-adjacent path so a typo doesn't surface as a 502 in prod.
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    return raw;
  } catch {
    return null;
  }
}

export const AA_ENV = {
  bundlerRequestTimeoutMs: 15_000,
  bundlerMaxBodyBytes: 256 * 1024,
} as const;
```

Acceptance: unit test that `PIMLICO_BUNDLER_URL_43114=https://...` resolves; `http://` rejects; missing key returns null.

### Step 2 — Chain-config helper (`be/src/helpers/chainConfig.ts`)

```ts
import { readBundlerUrl } from "./env/aaEnv";

/**
 * Per-chain pimlico bundler URL, sourced from env via aaEnv. Returns null when
 * the chain has no bundler configured — caller decides how to surface that
 * (the http route surfaces it as 503). Chain-agnostic per the CLAUDE.md rule:
 * the env key is computed from the chainId, never hardcoded.
 */
export function getBundlerUrl(chainId: number): string | null {
  if (!CHAIN_REGISTRY[chainId]) return null;
  return readBundlerUrl(chainId);
}
```

Acceptance: returns the configured URL for a known chain; null for unknown chainId or unset env.

### Step 3 — Proxy adapter (`be/src/adapters/implementations/output/aa/pimlicoBundlerProxy.ts`)

```ts
import { createLogger } from "../../../../helpers/observability/logger";
import { AA_ENV } from "../../../../helpers/env/aaEnv";
import { getBundlerUrl } from "../../../../helpers/chainConfig";

const log = createLogger("pimlicoBundlerProxy");

export interface BundlerForwardResult {
  /** HTTP status from pimlico, or 0 when fetch threw without a response. */
  status: number;
  body: Buffer | null;
  /** Set when fetch threw before/instead of producing a response. */
  upstreamError?: string;
}

export class PimlicoBundlerProxy {
  async forward(args: {
    chainId: number;
    body: Buffer;
    reqId: string;
    userId: string;
    method: string | undefined;
  }): Promise<BundlerForwardResult> {
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
      { reqId: args.reqId, chainId: args.chainId, method: args.method, bodyBytes: args.body.byteLength },
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
      const level = res.status >= 400 ? "warn" : "info";
      log[level](
        {
          reqId: args.reqId,
          chainId: args.chainId,
          method: args.method,
          status: res.status,
          durationMs: Date.now() - start,
          upstreamBytes: buf.byteLength,
        },
        "bundler-proxy-result",
      );
      return { status: res.status, body: buf };
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log.warn(
        {
          reqId: args.reqId,
          chainId: args.chainId,
          method: args.method,
          durationMs: Date.now() - start,
          err: msg,
        },
        "bundler-proxy-upstream-failed",
      );
      return { status: 0, body: null, upstreamError: msg };
    }
  }
}
```

Acceptance: an integration test that points `getBundlerUrl(31337)` at a stub HTTP server returns the stub's status + body unchanged; that timeout returns `{ status: 0, upstreamError: ... }`.

### Step 4 — DI wiring (`be/src/adapters/inject/*.di.ts`)

- Construct `const pimlicoBundlerProxy = new PimlicoBundlerProxy()` near where the other adapters are built.
- Pass into the `HttpServer` constructor: `pimlicoBundlerProxy`.
- Update the `HttpServer` constructor signature + its `HttpServerDeps`-equivalent type.

Acceptance: `npm run build` passes. No new deps to register; the proxy is a plain class with no constructor args.

### Step 5 — Route handler (`httpServer.ts`)

Add to `paramRoutes` (the param-pattern table — `:chainId` is a path param). The existing code uses a regex match against pathname; follow the same shape as other `:id` routes if present, otherwise add a small `paramRoutes` entry. Pseudocode for `handleBundlerProxy`:

```ts
private async handleBundlerProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _url: URL,
  chainIdRaw: string,
): Promise<void> {
  const reqId = this.reqLogIds.get(req) ?? "?";
  const chainId = Number(chainIdRaw);
  if (!Number.isFinite(chainId)) return this.sendJson(res, 404, { error: "Not found" });

  // Body size cap before reading.
  const len = Number(req.headers["content-length"] ?? 0);
  if (len > AA_ENV.bundlerMaxBodyBytes) {
    return this.sendJson(res, 413, { error: "Request entity too large" });
  }

  // Auth — Authorization: Bearer <privyToken>.
  const token = readBearerToken(req);
  if (!token) return this.sendJson(res, 401, { error: "Unauthorized" });
  const userId = await this.authUseCase.resolveUserId(token);
  if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });

  // Read raw bytes — do NOT JSON-parse-then-stringify (preserve exact bytes).
  const body = await readRawBody(req, AA_ENV.bundlerMaxBodyBytes);
  if (!body) return this.sendJson(res, 400, { error: "Empty body" });

  // Best-effort method extraction for logging only. Errors here do not abort.
  let method: string | undefined;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    method = Array.isArray(parsed)
      ? parsed.slice(0, 4).map((r) => r?.method).filter(Boolean).join(",")
      : parsed?.method;
  } catch {
    /* leave method undefined — pimlico will reject and we'll log status */
  }

  const result = await this.pimlicoBundlerProxy.forward({
    chainId, body, reqId, userId, method,
  });

  if (result.status === 0) {
    return this.sendJson(res, 502, { error: "bundler-upstream-failed", details: result.upstreamError });
  }

  // Pass through status + body verbatim. Set application/json explicitly so
  // viem's transport sees the right content-type — pimlico always returns JSON.
  res.writeHead(result.status, { "Content-Type": "application/json" });
  res.end(result.body ?? Buffer.alloc(0));
}
```

Register:

```ts
// In matchRoute / paramRoutes wiring:
["POST", /^\/aa\/bundler\/(\d+)$/, (req, res, url, chainIdRaw) => this.handleBundlerProxy(req, res, url, chainIdRaw)],
```

`readBearerToken` and `readRawBody` are tiny helpers — either inline them or co-locate in `httpServer.ts` near `readJson`. `readRawBody` should accumulate chunks into a Buffer and reject with 413 if total exceeds the cap (re-check during read in case `Content-Length` lied).

Acceptance:

- `curl -i -X POST http://localhost:PORT/aa/bundler/43114 -H 'authorization: Bearer <good-token>' -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_supportedEntryPoints","params":[]}'` returns 200 with pimlico's JSON.
- Same call without `Authorization` returns 401.
- Same call with `chainId=999999` returns 503 ("no-bundler-configured").
- Same call with a 300 KB body returns 413.
- Logs show one `bundler-proxy-forward` + one `bundler-proxy-result` per call, with correlated `reqId`.

### Step 6 — Env example + ops note

Append to `be/.env.example`:

```
# ==========================================
# AA Bundler Proxy
# ==========================================
# Per-chain pimlico bundler URLs. The FE never sees these — the FE posts
# to /aa/bundler/<chainId> on this BE, which forwards to the URL below.
# Format: https://api.pimlico.io/v2/<chainId>/rpc?apikey=<key>
# Add one PIMLICO_BUNDLER_URL_<chainId> entry per supported chain.
PIMLICO_BUNDLER_URL_43114=
PIMLICO_BUNDLER_URL_56=
PIMLICO_BUNDLER_URL_137=
```

(43113 / Fuji omitted — wire only if we test on Fuji; the registry still includes the chain, the helper just returns null and the route returns 503.)

### Step 7 — Tests

Add to `be/tests`:

1. `pimlicoBundlerProxy.test.ts` — spin up an http server on `127.0.0.1:0`, point `PIMLICO_BUNDLER_URL_31337` at it, assert status + body pass-through, timeout behavior, byte-exact body preservation (post a body with key ordering `{"z":1,"a":2}` and confirm the test server received it unchanged).
2. `bundlerProxyRoute.test.ts` — boot the http server with a fake `IAuthUseCase` that accepts a fixed token; verify auth, size cap, route param parsing.

Both run under existing `npm test`.

### Step 8 — Deploy ordering

1. Ship the BE change. Set `PIMLICO_BUNDLER_URL_43114` (and any other chains in use) in prod env.
2. Verify with curl from a workstation against the prod URL using a real Privy token. Expect a real pimlico response.
3. Ship the FE change (see paired plan). FE flips to the proxied URL.
4. Once the FE is rolled out and confirmed working in Telegram Desktop macOS, **rotate the pimlico API key on the dashboard** (the old one was shipped to clients) and update the BE env. FE is unaffected — it no longer holds the key.

Rollback plan: if step 3 introduces a regression, flip FE's `VITE_PIMLICO_BUNDLER_URL` back to direct pimlico and redeploy. The BE proxy route can stay in place; it just becomes unused. No DB migration to revert.

## Conventions introduced (record in status.md)

- `aaEnv.ts` is the new home for AA-stack runtime config (timeouts, body caps, per-chain proxied URLs). Future AA adapters (paymaster proxy, alt-bundler) should read from here.
- Route path prefix `/aa/*` is reserved for AA-related infrastructure proxies.
- New logger scope `pimlicoBundlerProxy`. Metadata names: `chainId`, `method`, `bodyBytes`, `upstreamBytes`, `durationMs`, `status`, `err`.

## Risks & mitigations

- **Latency overhead.** Adds one BE hop. In practice 10–50 ms vs the user's TG-WebView → CF path. Acceptable; the alternative is the FE failing 100% of the time on macOS.
- **BE becomes a chokepoint for AA traffic.** Mitigated by the proxy being stateless (horizontal scale matches the rest of the BE) and by the upstream timeout (no zombie connections).
- **Leaking the bundler URL into BE logs.** The URL contains the API key. Never log the URL — only the chainId. The proxy code above adheres to this; reviewers should grep for `bundlerUrl` in any log line.
- **Pimlico changes its response shape.** Pass-through is byte-exact, so any new fields propagate to the FE without a BE change.

## What does "done" look like

- `/aa/bundler/43114` reachable in staging with a real Privy token.
- Telegram Desktop macOS user runs `/send 0.01 USDC <addr>` and `/swap` and both succeed.
- Pimlico dashboard shows the new traffic originating from the BE's IP, not from client IPs.
- Old pimlico API key rotated; FE no longer references `VITE_PIMLICO_BUNDLER_URL` or has any pimlico key in its bundle.
