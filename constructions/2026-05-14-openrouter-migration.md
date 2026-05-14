# OpenRouter Migration Plan

**Date:** 2026-05-14
**Status:** Planned
**Owner:** TBD

## Goal

Replace the OpenAI SDK as the chat/LLM provider with **OpenRouter** (OpenAI-SDK-compatible
endpoint at `https://openrouter.ai/api/v1`), because the project's OpenAI quota is exhausted.

- All chat/completion call sites switch to OpenRouter, default model
  `openai/gpt-5-mini`.
- **Embeddings stay on OpenAI** (the tool semantic-search path is deprecated and the only
  embedding consumer; embeddings on OpenRouter aren't supported anyway). It will continue
  using the existing `OPENAI_API_KEY` against `api.openai.com`.

## Scope

### Migrated to OpenRouter (6 files)

- `be/src/adapters/implementations/output/orchestrator/openai.ts`
- `be/src/adapters/implementations/output/intentInterpreter/openai.intentInterpreter.ts`
- `be/src/adapters/implementations/output/intentParser/openai.schemaCompiler.ts`
- `be/src/adapters/implementations/output/predictionMarket/openaiPredictionMarketClassifier.ts`
- `be/src/adapters/implementations/output/predictionMarket/openaiPredictionMarketDetector.ts`
- `be/src/adapters/implementations/output/predictionMarket/openaiPredictionMarketExtractor.ts`

### Untouched (stays on OpenAI)

- `be/src/adapters/implementations/output/embedding/openai.ts`
  (uses `text-embedding-3-small`; deprecated tool-index path is the sole consumer.)

## Configuration changes

### `be/src/helpers/env/openaiEnv.ts`

Currently the single source of truth for `OPENAI_API_KEY` + `OPENAI_MODEL` (default `gpt-4o`).
Extend (do **not** rename — too many call sites; treat this file as the "LLM env" hub):

```ts
// Existing — kept for the embedding service only.
export const OPENAI_API_KEY: string | undefined = process.env.OPENAI_API_KEY;

// New — chat/completions provider.
export const OPENROUTER_API_KEY: string | undefined = process.env.OPENROUTER_API_KEY;
export const OPENROUTER_BASE_URL: string =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

// Optional analytics headers (OpenRouter recommends these).
export const OPENROUTER_REFERER: string | undefined = process.env.OPENROUTER_REFERER;
export const OPENROUTER_APP_TITLE: string | undefined = process.env.OPENROUTER_APP_TITLE;

// Default model — changed from "gpt-4o" to OpenRouter slug.
export const OPENAI_MODEL: string = process.env.OPENAI_MODEL ?? "openai/gpt-5-mini";
```

Notes:
- The exported symbol name `OPENAI_MODEL` is kept to avoid touching 7+ import sites; its
  semantics change from "OpenAI chat model" to "LLM chat model (OpenRouter slug)".
- Document this in `status.md` (see "Status.md updates").

### `be/src/helpers/env/predictionMarketEnv.ts`

Change defaults:

- `PREDICTION_MARKETS_CLASSIFIER_MODEL`: `gpt-4o` → `openai/gpt-5-mini` (two occurrences,
  lines 28 and 44).
- `PREDICTION_MARKETS_EXTRACTOR_MODEL`: `gpt-4.1-mini` → `openai/gpt-5-mini` (line 78);
  update the comment block (line 76) accordingly.
- Detector model (if it has its own env, line ~ search `PREDICTION_MARKETS_DETECTOR_MODEL`)
  → `openai/gpt-5-mini`.

### `be/src/helpers/env/resultCardEnv.ts`

`RESULT_CARD_INTERPRETER_MODEL` falls back to `OPENAI_MODEL` — picks up the new default
automatically. `apiKey` field at line 21 currently reads `OPENAI_API_KEY`; switch to
`OPENROUTER_API_KEY` since the result-card interpreter is an LLM consumer (chat), not an
embedding consumer.

### `.env` / `.env.example`

Add:
```
OPENROUTER_API_KEY=sk-or-v1-...
# optional:
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_REFERER=https://your-app-domain
OPENROUTER_APP_TITLE=aegis
```

Keep `OPENAI_API_KEY` set (used by embeddings only).

## New DI helper

Add a single factory in `be/src/adapters/inject/assistant.di.ts` (or a small new file
`be/src/helpers/llm/openrouterClient.ts` — see "Why a helper" below):

```ts
import OpenAI from "openai";
import {
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  OPENROUTER_REFERER,
  OPENROUTER_APP_TITLE,
} from "../env/openaiEnv";

export function createOpenRouterClient(): OpenAI {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }
  return new OpenAI({
    apiKey: OPENROUTER_API_KEY,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      ...(OPENROUTER_REFERER ? { "HTTP-Referer": OPENROUTER_REFERER } : {}),
      ...(OPENROUTER_APP_TITLE ? { "X-Title": OPENROUTER_APP_TITLE } : {}),
    },
  });
}
```

**Why a helper:** the `baseURL` + headers should not be inlined into every adapter
(violates CLAUDE.md "no hardcoded values"). A single factory means switching providers
later is a one-line change.

## Per-file changes

### 1. `orchestrator/openai.ts`

- Replace `new OpenAI({ apiKey })` (line 27) with `createOpenRouterClient()`.
- The constructor still receives `apiKey` and `model` from DI; drop the `apiKey` arg
  (or keep it for backward signature compat and ignore it — flag in PR).
- `chat.completions.create` call (line 75) with `tools` + `tool_choice: "auto"` stays
  unchanged. Add `provider: { require_parameters: true }` to the request body to ensure
  OpenRouter routes only to providers that honor `tools`:
  ```ts
  this.client.chat.completions.create({
    model: this.model,
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    // @ts-expect-error — OpenRouter-specific routing hint not in OpenAI types
    provider: { require_parameters: true },
  });
  ```
- Tool-call response shape (`tool_calls[].function.arguments`, line 117) is unchanged for
  `openai/gpt-5-mini`. **Verify** in smoke test.

### 2. `intentInterpreter/openai.intentInterpreter.ts`

- Replace `new OpenAI({ apiKey })` (line 44) with `createOpenRouterClient()`.
- `chat.completions.create` (line 119) with `max_tokens: 80, temperature: 0.4` (lines
  122–123):
  - **Risk:** `gpt-5-mini` is a reasoning model. `temperature` may be ignored; `max_tokens`
    may be too small once reasoning tokens are produced. Bump `max_tokens` to ~300 to be
    safe, and consider switching to `max_completion_tokens` if the SDK version supports it.
  - Keep `temperature` for backward compat — OpenRouter will ignore it for models that
    don't support it.

### 3. `intentParser/openai.schemaCompiler.ts`

- Replace `new OpenAI({ apiKey })` (line 101) with `createOpenRouterClient()`.
- `chat.completions.parse` (line 125) with `zodResponseFormat(CompileSchema, ...)` (line
  131): this is the OpenAI SDK beta helper. It posts a `response_format` with a strict
  JSON Schema and post-parses the response. **OpenRouter supports it** for OpenAI-family
  models. Add `provider: { require_parameters: true }` to fail loudly rather than fall
  back to a non-strict provider.
- Second call site `chat.completions.create` (line 188): same treatment.

### 4. `predictionMarket/openaiPredictionMarketClassifier.ts`

- Replace `new OpenAI({ apiKey: cfg.apiKey })` (line 168) with `createOpenRouterClient()`.
- `chat.completions.create` (line 245) with
  `response_format: { type: "json_schema", json_schema: CLUSTER_SCHEMA }`: works on
  OpenRouter for `openai/*` models. Add `provider: { require_parameters: true }`.

### 5. `predictionMarket/openaiPredictionMarketDetector.ts`

- Replace `new OpenAI({ apiKey: cfg.apiKey })` (line 203) with `createOpenRouterClient()`.
- Same structured-outputs treatment at line 287 (`FINDING_SCHEMA`).

### 6. `predictionMarket/openaiPredictionMarketExtractor.ts`

- Replace `new OpenAI({ apiKey: cfg.apiKey })` (line 116) with `createOpenRouterClient()`.
- Same structured-outputs treatment at line 156 (`EXTRACTOR_SCHEMA`).

### `assistant.di.ts` wiring

The constructors currently take an `apiKey: string` argument. Two options:

- **Option A (minimal diff):** Keep the `apiKey` parameter, ignore it inside the
  constructor (use `createOpenRouterClient()`), and pass any non-empty string from DI.
  Mark the parameter `@deprecated` in JSDoc.
- **Option B (clean):** Drop the `apiKey` parameter from each constructor; update the
  6 call sites in `assistant.di.ts` (lines 376, 386, 409, 1313, 1349, 1506).

Recommend **Option B** — six call sites, one diff, no dead arguments lingering.

The embedding service path (line 314–320) is untouched and continues to read
`process.env.OPENAI_API_KEY`.

## Rate limiter

`be/src/helpers/concurrency/openaiLimiter.ts` is shared across all OpenAI calls. After
migration it's still used by the embedding service AND the 6 chat sites — fine for now;
note that OpenRouter's 429 semantics differ slightly (per-key rolling, not per-org-tier).
Retune ceilings only if we see throttling in production.

## Logging

Every adapter already follows the project logger convention. Add a startup `log.info`
in `createOpenRouterClient` (one-shot, gated behind a memoized flag) to record:

```ts
log.info({ baseURL: OPENROUTER_BASE_URL, model: OPENAI_MODEL }, "openrouter-client-initialized");
```

No per-request log changes needed — existing `step` events at the adapter level remain
correct.

## Metrics

`helpers/observability/metricsRegistry.ts` has `openai_*` metric names. **Do not rename**
in this PR — would force a Grafana/dashboard migration. Add a comment in that file noting
the labels are historical and now cover OpenRouter-routed calls too.

## Status.md updates

Update the relevant `status.md` (likely `be/src/adapters/implementations/output/status.md`
and the prediction-market `status.md`) with:

1. **New convention:** chat-completion adapters use `createOpenRouterClient()` from
   `helpers/llm/openrouterClient.ts`. Direct `new OpenAI({ apiKey })` is reserved for
   the embedding adapter (`api.openai.com`).
2. **Two-client architecture:** `OPENAI_API_KEY` → embeddings only; `OPENROUTER_API_KEY` →
   chat.
3. **Default model:** `openai/gpt-5-mini` (OpenRouter slug — note the `openai/` prefix is
   required by OpenRouter, not the bare model name).
4. **Structured-outputs guarantee:** all `response_format: json_schema` and
   `zodResponseFormat` call sites set `provider: { require_parameters: true }` so
   OpenRouter rejects routing to providers that don't honor strict schemas.

## Test plan

1. **Unit / type compile:** `npm run typecheck` (or equivalent) in `be/`.
2. **Smoke — intent interpreter:** trigger a simple "what's my balance" intent; verify
   the orchestrator call returns and a tool_call is parsed correctly.
3. **Smoke — schema compiler:** trigger a path that exercises `chat.completions.parse`;
   confirm a strict-schema response is parsed without `SCHEMA_INVALID` errors.
4. **Smoke — prediction markets:** run classifier / detector / extractor against a known
   fixture market; confirm JSON-schema output validates.
5. **Embeddings unaffected:** verify (if the deprecated tool-search path still has any
   live callers) that `OpenAIEmbeddingService.embed()` continues to work against
   `api.openai.com`.
6. **Cost & latency baseline:** record p50/p95 latency for the orchestrator and the
   prediction-market extractor against `openai/gpt-5-mini` and compare to historical
   `gpt-4o-mini` numbers. Reasoning tokens may significantly inflate both.

## Rollback

Single env-var rollback: unset `OPENROUTER_API_KEY` and revert `OPENAI_MODEL` to
`gpt-4o`. With Option A above, no code revert is needed. With Option B, also revert the
DI changes.

## Open questions

- Confirm the exact OpenRouter slug for the requested model (`openai/gpt-5-mini` is the
  expected form). If the slug differs, update `OPENAI_MODEL` default + the three
  prediction-market env defaults in lockstep.
- Decide on `OPENROUTER_REFERER` / `OPENROUTER_APP_TITLE` values for production.
