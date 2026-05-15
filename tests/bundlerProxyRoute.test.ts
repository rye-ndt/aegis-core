/**
 * Route-level test for `POST /aa/bundler/:chainId`. Boots a real
 * HttpApiServer with a stubbed `IAuthUseCase` and a stubbed bundler URL +
 * fetch shim, then asserts auth, body-size cap, route param parsing, and
 * pass-through of the upstream response.
 *
 * Run with: npx tsx --test tests/bundlerProxyRoute.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";

process.env.PIMLICO_BUNDLER_URL_43114 = "https://stub.invalid/rpc";

import { HttpApiServer } from "../src/adapters/implementations/input/http/httpServer";
import { PimlicoBundlerProxy } from "../src/adapters/implementations/output/aa/pimlicoBundlerProxy";
import type { IAuthUseCase } from "../src/use-cases/interface/input/auth.interface";

const GOOD_TOKEN = "good-token";
const USER_ID = "user-123";

const fakeAuth: IAuthUseCase = {
  async loginWithPrivy() { return { expiresAtEpoch: 0, userId: USER_ID }; },
  async resolveUserId(token: string) { return token === GOOD_TOKEN ? USER_ID : null; },
};

interface UpstreamCall { body: Buffer }
function stubFetch(behaviour: { status: number; body: Buffer } | "throw"): { restore: () => void; calls: UpstreamCall[] } {
  const original = globalThis.fetch;
  const calls: UpstreamCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // Only intercept upstream pimlico calls; the test client also uses fetch
    // to talk to the BE on 127.0.0.1, and those must hit the real server.
    if (!url.includes("stub.invalid")) {
      return original(input as RequestInfo, init);
    }
    const b = init?.body;
    const buf = b instanceof Buffer ? b : typeof b === "string" ? Buffer.from(b) : Buffer.from(b as Uint8Array);
    calls.push({ body: buf });
    if (behaviour === "throw") throw new TypeError("Load failed");
    return new Response(behaviour.body, { status: behaviour.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls };
}

async function boot(): Promise<{ baseUrl: string; close: () => void }> {
  // Construct with the bare minimum: authUseCase, port=0 (we override below),
  // and the bundler proxy. Every other dep is optional. Constructor takes
  // authUseCase, port, then 24 optional deps, then the optional bundler proxy.
  const optionalDeps = new Array(24).fill(undefined);
  const server = new HttpApiServer(
    fakeAuth,
    0,
    ...(optionalDeps as []),
    new PimlicoBundlerProxy(),
  );
  // The HttpApiServer manages its own http.Server — but `port: 0` makes it
  // pick an ephemeral port. We can read the port back via the underlying
  // server instance after start(). Reach in via `as any` since this is a
  // test-only escape hatch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = (server as any).server as import("node:http").Server;
  await new Promise<void>((r) => internal.listen(0, "127.0.0.1", () => r()));
  const port = (internal.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => internal.close(),
  };
}

async function postBundler(baseUrl: string, chainId: number | string, body: string | Buffer, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseUrl}/aa/bundler/${chainId}`, { method: "POST", body, headers });
  return { status: res.status, text: await res.text() };
}

test("POST /aa/bundler/:chainId — happy path forwards body and pass-through status", async () => {
  const upstream = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: ["0xEntry"] }));
  const { restore, calls } = stubFetch({ status: 200, body: upstream });
  const { baseUrl, close } = await boot();
  try {
    const reqBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_supportedEntryPoints", params: [] });
    const out = await postBundler(baseUrl, 43114, reqBody, {
      "content-type": "application/json",
      authorization: `Bearer ${GOOD_TOKEN}`,
    });
    assert.equal(out.status, 200);
    assert.equal(out.text, upstream.toString("utf8"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.body.toString("utf8"), reqBody);
  } finally {
    close();
    restore();
  }
});

test("POST /aa/bundler/:chainId — 401 without Authorization", async () => {
  const { restore } = stubFetch({ status: 200, body: Buffer.from("{}") });
  const { baseUrl, close } = await boot();
  try {
    const out = await postBundler(baseUrl, 43114, "{}", { "content-type": "application/json" });
    assert.equal(out.status, 401);
  } finally {
    close();
    restore();
  }
});

test("POST /aa/bundler/:chainId — 401 with bad token", async () => {
  const { restore } = stubFetch({ status: 200, body: Buffer.from("{}") });
  const { baseUrl, close } = await boot();
  try {
    const out = await postBundler(baseUrl, 43114, "{}", {
      "content-type": "application/json",
      authorization: "Bearer wrong-token",
    });
    assert.equal(out.status, 401);
  } finally {
    close();
    restore();
  }
});

test("POST /aa/bundler/:chainId — 503 when no bundler configured for chain", async () => {
  const { restore } = stubFetch({ status: 200, body: Buffer.from("{}") });
  const { baseUrl, close } = await boot();
  try {
    // 999999 is not in CHAIN_REGISTRY → getBundlerUrl null → upstreamError="no-bundler-configured" → 503.
    const out = await postBundler(baseUrl, 999999, JSON.stringify({ method: "x" }), {
      "content-type": "application/json",
      authorization: `Bearer ${GOOD_TOKEN}`,
    });
    assert.equal(out.status, 503);
    assert.match(out.text, /no-bundler-configured/);
  } finally {
    close();
    restore();
  }
});

test("POST /aa/bundler/:chainId — 413 when Content-Length exceeds cap", async () => {
  const { restore } = stubFetch({ status: 200, body: Buffer.from("{}") });
  const { baseUrl, close } = await boot();
  try {
    const big = Buffer.alloc(300 * 1024, 0x7b); // 300KB > 256KB cap
    const out = await postBundler(baseUrl, 43114, big, {
      "content-type": "application/json",
      authorization: `Bearer ${GOOD_TOKEN}`,
      "content-length": String(big.byteLength),
    });
    assert.equal(out.status, 413);
  } finally {
    close();
    restore();
  }
});

test("POST /aa/bundler/:chainId — 502 when upstream throws", async () => {
  const { restore } = stubFetch("throw");
  const { baseUrl, close } = await boot();
  try {
    const out = await postBundler(baseUrl, 43114, JSON.stringify({ method: "eth_sendUserOperation" }), {
      "content-type": "application/json",
      authorization: `Bearer ${GOOD_TOKEN}`,
    });
    assert.equal(out.status, 502);
    assert.match(out.text, /bundler-upstream-failed/);
  } finally {
    close();
    restore();
  }
});

test("POST /aa/bundler/:chainId — 504 when upstream times out (AbortError)", async () => {
  // Mimic AbortSignal.timeout() throwing once the cap fires. The proxy maps
  // AbortError/TimeoutError → upstreamError:"timeout", which the route then
  // surfaces as 504 (distinct from 502 connection errors). Scope the throw to
  // upstream calls only — the test client's own fetch to the BE must succeed.
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("stub.invalid")) return original(input as RequestInfo, init);
    const e = new Error("The operation was aborted due to timeout");
    e.name = "TimeoutError";
    throw e;
  }) as typeof fetch;
  const { baseUrl, close } = await boot();
  try {
    const out = await postBundler(baseUrl, 43114, JSON.stringify({ method: "eth_sendUserOperation" }), {
      "content-type": "application/json",
      authorization: `Bearer ${GOOD_TOKEN}`,
    });
    assert.equal(out.status, 504);
    assert.match(out.text, /timeout/);
  } finally {
    close();
    globalThis.fetch = original;
  }
});

test("POST /aa/bundler/:chainId — logs all methods in a JSON-RPC batch", async () => {
  // Best-effort method extraction should report up to 4 methods joined by
  // commas for batch payloads. We can't easily inspect the log line from a
  // black-box test, so we assert via behaviour: the request still forwards.
  // The method-extraction regression test lives in the unit test for the
  // logger; here we just ensure batch payloads don't crash the route.
  const upstream = Buffer.from(JSON.stringify([
    { jsonrpc: "2.0", id: 1, result: "a" },
    { jsonrpc: "2.0", id: 2, result: "b" },
  ]));
  const { restore } = stubFetch({ status: 200, body: upstream });
  const { baseUrl, close } = await boot();
  try {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_estimateUserOperationGas", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_sendUserOperation",        params: [] },
    ]);
    const out = await postBundler(baseUrl, 43114, batch, {
      "content-type": "application/json",
      authorization: `Bearer ${GOOD_TOKEN}`,
    });
    assert.equal(out.status, 200);
    assert.equal(out.text, upstream.toString("utf8"));
  } finally {
    close();
    restore();
  }
});

test("POST /aa/bundler/:chainId — non-numeric chainId is not matched (404)", async () => {
  const { restore } = stubFetch({ status: 200, body: Buffer.from("{}") });
  const { baseUrl, close } = await boot();
  try {
    // The route regex requires \d+, so "abc" falls through to the default 404.
    const out = await postBundler(baseUrl, "abc", "{}", {
      "content-type": "application/json",
      authorization: `Bearer ${GOOD_TOKEN}`,
    });
    assert.equal(out.status, 404);
  } finally {
    close();
    restore();
  }
});
