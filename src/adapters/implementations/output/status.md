# Output adapters — status

## LLM provider split (2026-05-14 OpenRouter migration)

Two-client architecture for the LLM family:

- **Embedding adapter** (`embedding/openai.ts`) — keeps `new OpenAI({ apiKey })`
  authenticated with `OPENAI_API_KEY` against `api.openai.com`. OpenRouter does
  not serve embeddings, and the deprecated tool semantic-search path is the
  only embedding consumer.
- **All chat/completions adapters** — use `createOpenRouterClient()` from
  `helpers/llm/openrouterClient.ts`. Direct `new OpenAI({ apiKey })` is
  forbidden for chat callers; centralising the factory means `baseURL`,
  analytics headers, and routing hints are configured once.

### Affected chat adapters

- `orchestrator/openai.ts` (function-tool dispatch)
- `intentInterpreter/openai.intentInterpreter.ts` (result-card notes)
- `intentParser/openai.schemaCompiler.ts` (`chat.completions.parse` +
  `chat.completions.create` for question generation)
- `predictionMarket/openaiPredictionMarketClassifier.ts`
- `predictionMarket/openaiPredictionMarketDetector.ts`
- `predictionMarket/openaiPredictionMarketExtractor.ts`

### Conventions to preserve

1. **No inline `new OpenAI(...)` in chat code.** Call `createOpenRouterClient()`.
2. **Constructor signatures** for the six chat adapters no longer accept an
   `apiKey` argument. Auth comes from `OPENROUTER_API_KEY` via the factory.
3. **Model slug is the OpenRouter `<provider>/<model>` form.** The default
   `OPENAI_MODEL` is `openai/gpt-5-mini`. The exported symbol name
   `OPENAI_MODEL` is preserved for import-site stability; its semantics are
   now "chat-model slug for OpenRouter", not "bare OpenAI model id".
4. **Strict structured outputs.** Every request that uses `tools` or a strict
   `response_format` (`zodResponseFormat` / `{ type: "json_schema", ... }`)
   must attach `OPENROUTER_REQUIRE_PARAMETERS` (re-exported from
   `helpers/llm/openrouterClient.ts`) via `Object.assign` AFTER the request
   literal is built. Do **not** spread it into the literal with `as any` —
   that collapses the OpenAI SDK's parse-shape inference and breaks the
   typed `response.choices[0].message.parsed` field downstream.
5. **DI gating.** Chat adapters in `assistant.di.ts` are gated on
   `OPENROUTER_API_KEY` (not `OPENAI_API_KEY`). The embedding service in the
   same file remains gated on `OPENAI_API_KEY`.
6. **Result-card env.** `resultCardEnv.apiKey` now reads
   `OPENROUTER_API_KEY` (chat consumer); it is no longer tied to the
   embedding key.

### Why centralise the factory

CLAUDE.md "no hardcoded values": `baseURL`, `HTTP-Referer`, and `X-Title`
must not be inlined into every adapter. A single factory keeps provider
switching to a one-file change and prevents drift between adapters (e.g. one
forgetting the `provider: { require_parameters: true }` routing hint).

### Reasoning-model `max_tokens` note

`intentInterpreter` raised its `max_tokens` cap from 80 → 300. Reasoning-
capable OpenRouter models (`openai/gpt-5-mini` and successors) silently
consume tokens for hidden chain-of-thought; a tight cap produces empty
user-visible output. `temperature` is left in place — OpenRouter ignores it
for models that don't support it.

## AA bundler proxy (2026-05-15)

New adapter `aa/pimlicoBundlerProxy.ts` forwards ERC-4337 JSON-RPC traffic
from the FE to pimlico server-side. Wired to `POST /aa/bundler/:chainId` in
`httpServer.ts` (Privy-token gated, 256 KB body cap, 15 s timeout).

### Why a server-side proxy

`eth_sendUserOperation` from Telegram Desktop's macOS WKWebView fails with
`TypeError: Load failed` for bodies ≳8 KB. The FE has no recoverable signal,
so the BE proxies the call. Side benefits: the pimlico API key leaves the
FE bundle, no CORS preflight on the bundler path, and the URL/key can rotate
without a new FE build.

### Conventions introduced

- **`/aa/*` route prefix** is reserved for AA-stack infrastructure proxies.
  Future paymaster/alt-bundler proxies belong here, not under feature paths.
- **`IBundlerProxy` port** in
  `use-cases/interface/output/aa/bundlerProxy.interface.ts`. Input adapters
  (HTTP server) depend on the interface, never the concrete
  `PimlicoBundlerProxy` — swapping providers (self-hosted, stackup, alchemy)
  is a one-line DI change.
- **`helpers/env/aaEnv.ts`** is the home for AA-stack runtime config
  (timeouts, body caps, per-chain proxied URLs). New AA adapters read from
  here instead of `process.env` directly. Tunables are env-overridable with
  bounded fallbacks — `AA_BUNDLER_TIMEOUT_MS` (1_000..120_000, default
  15_000) and `AA_BUNDLER_MAX_BODY_BYTES` (1_024..4_194_304, default
  262_144).
- **Per-chain bundler URLs are env-only** (`PIMLICO_BUNDLER_URL_<chainId>`).
  Resolved via `getBundlerUrl(chainId)` in `chainConfig.ts`. Stays
  chain-agnostic — the env key is computed from the chainId, never hardcoded
  in adapters or routes.
- **Body forwarding is byte-exact** — the route reads raw bytes (new
  `readRawBody` helper in `httpServer.ts`) and the adapter passes the Buffer
  straight to `fetch`. We must not `JSON.parse → JSON.stringify`: that would
  reorder keys and coerce big-int userOp fields like `nonce`/`callGasLimit`.
- **Auth is Authorization-header only** for `/aa/bundler/*`; we deliberately
  skip the `userId → SCA` cross-check (would require parsing the body and
  defeat the byte-exact forward; pimlico's paymaster verifies the userOp
  downstream).
- **Logger scope `pimlicoBundlerProxy`.** New metadata field names:
  `chainId`, `method`, `bodyBytes`, `upstreamBytes`, `timedOut`,
  `declaredLen` (alongside the standard `reqId`/`status`/`durationMs`/`err`).
  `timedOut: true` distinguishes our timeout ceiling tripping from other
  upstream failures; the route maps it to 504 (vs 502 for other throws,
  503 for `no-bundler-configured`). `declaredLen` is the inbound
  `Content-Length` header used for the 413 pre-check.
