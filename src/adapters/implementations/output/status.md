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
