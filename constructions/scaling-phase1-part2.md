# Scaling Phase 1 — Part 2: LLM concurrency cap + prompt-cache preservation

> Prerequisite: none (Phase 1 parts are independent).
> Behavior change: **none.** Same LLM calls, same prompts, same tool results. Under load, slow requests queue in-process instead of stampeding OpenAI.
> Expected capacity lift (with part 1): ~10 → ~30 users. Token cost drop: 30–60% on chat turns after first (via OpenAI's automatic prompt caching — see Step 2.2).

## Why

Two problems at `src/adapters/implementations/output/orchestrator/openai.ts`:

1. **Line 68** — `await this.client.chat.completions.create(...)` has no concurrency cap. 30 concurrent users → 30 parallel OpenAI requests → OpenAI tier rate-limit → exponential retries inside the SDK → 30-second tail latency for everyone.
2. **Prompt caching is partially broken.** OpenAI automatically caches prompt prefixes ≥ 1024 tokens, but the prefix must be byte-identical across requests. `src/use-cases/implementations/assistant.usecase.ts:67-68` does:

   ```ts
   const systemPrompt =
     `${DEFAULT_SYSTEM_PROMPT}\n\nCurrent datetime: ${new Date().toISOString()}.`;
   ```
   `new Date().toISOString()` resolves to millisecond precision → prefix changes every call → **zero cache hits**. Fixing this is pure savings: same behavior, cheaper + faster.

## Step 2.1 — Global OpenAI concurrency cap

### 2.1.1 — Add `p-limit` dependency

```
cd be && npm install p-limit@5
```

Commit the `package.json` + `package-lock.json` change.

### 2.1.2 — Create a single shared limiter

New file `src/helpers/concurrency/openaiLimiter.ts`:

```ts
import pLimit from "p-limit";

const OPENAI_CONCURRENCY = Number(process.env.OPENAI_CONCURRENCY ?? 6);

export const openaiLimiter = pLimit(OPENAI_CONCURRENCY);
```

- One module-level limiter shared by all OpenAI callers within one Node process.
- `OPENAI_CONCURRENCY=6` is a conservative default for OpenAI Tier 1. With 6 replicas at 6 each = 36 simultaneous calls max, well under most tier quotas.
- Per-replica cap; **not** a cluster-wide cap. Cluster-wide would need Redis-backed semaphore — deferred to Phase 3 if needed.

### 2.1.3 — Wrap all hot-path OpenAI calls

Five files use `this.client.*`:

- `src/adapters/implementations/output/orchestrator/openai.ts:68` (chat)
- `src/adapters/implementations/output/embedding/openai.ts:17` (embeddings — RAG path)
- `src/adapters/implementations/output/intentParser/openai.intentParser.ts:95`
- `src/adapters/implementations/output/intentParser/openai.intentClassifier.ts:35`
- `src/adapters/implementations/output/intentParser/openai.schemaCompiler.ts:114,170`

In each file, import the limiter:

```ts
import { openaiLimiter } from "../../../../helpers/concurrency/openaiLimiter";
```
(path depth depends on the file — adjust relative segments.)

Wrap the call:

```ts
// before
const response = await this.client.chat.completions.create({ ... });

// after
const response = await openaiLimiter(() =>
  this.client.chat.completions.create({ ... }),
);
```

Same pattern for `.parse(…)` and `.embeddings.create(…)`.

**Do not** create per-caller limiters — it defeats the point. One shared limiter, five call sites.

### 2.1.4 — Env in `.env.example`

Append under `# Scaling — Phase 1`:

```
OPENAI_CONCURRENCY=6
```

## Step 2.2 — Stabilize the cacheable prefix

Edit `src/use-cases/implementations/assistant.usecase.ts`.

Replace line 67–68:

```ts
const systemPrompt =
  `${DEFAULT_SYSTEM_PROMPT}\n\nCurrent datetime: ${new Date().toISOString()}.`;
```

with:

```ts
// Datetime must not live inside the cached prefix — mutation invalidates
// OpenAI prompt-prefix caching every call. Move it into the user turn instead.
const systemPrompt = DEFAULT_SYSTEM_PROMPT;
```

Then in the `slidingWindow` construction a few lines below, change the user-message push from:

```ts
{
  role: MESSAGE_ROLE.USER,
  content: input.message,
  imageBase64Url: input.imageBase64Url,
},
```

to:

```ts
{
  role: MESSAGE_ROLE.USER,
  content: `[Current datetime: ${new Date().toISOString()}]\n${input.message}`,
  imageBase64Url: input.imageBase64Url,
},
```

Result: system + tools + older history stays byte-identical across calls → OpenAI caches the prefix automatically (no `cache_control` annotation is needed on OpenAI, unlike Anthropic). Datetime still reaches the model, just at the tail of the prompt where cache behavior does not care.

### Guard: tool list must be deterministically ordered

`src/use-cases/implementations/assistant.usecase.ts:63-64` already calls `toolRegistry.getAll().map(...)`. The registry order must be stable across calls (same tools, same order) for the cached prefix to stay valid. Verify:

```
grep -n "getAll()" src/adapters/implementations/output/toolRegistry.concrete.ts
```

If the impl returns a `Map` iteration order, that's deterministic by insertion — fine. If it does any sort-by-random, **stop** and fix that first. Otherwise no change needed.

## Step 2.3 — Log cache hits so we can verify savings

Edit `src/adapters/implementations/output/orchestrator/openai.ts` around line 72 (the existing `[OpenAIOrchestrator] response …` log). The OpenAI response object exposes `usage.prompt_tokens_details.cached_tokens` when cache is active. Change:

```ts
console.log(`[OpenAIOrchestrator] response finish_reason=${response.choices[0]?.finish_reason} promptTokens=${response.usage?.prompt_tokens} completionTokens=${response.usage?.completion_tokens}`);
```

to:

```ts
const cached = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
const prompt = response.usage?.prompt_tokens ?? 0;
const cacheHitRatio = prompt > 0 ? (cached / prompt).toFixed(2) : "0.00";
console.log(
  `[OpenAIOrchestrator] response finish_reason=${response.choices[0]?.finish_reason} ` +
  `promptTokens=${prompt} cachedTokens=${cached} cacheHitRatio=${cacheHitRatio} ` +
  `completionTokens=${response.usage?.completion_tokens}`,
);
```

This is for operator observability; the user never sees it.

## How to verify locally

1. `docker compose up -d postgres redis`
2. `npm run dev`
3. Hit the chat path 2–3 times for the same user with similar-length messages.
4. In logs, look for:
   - `[OpenAIOrchestrator] response … cachedTokens=N cacheHitRatio=0.XX` — first call = 0.00 (cold), subsequent calls > 0.5 (warm). If still 0.00, grep the final prompt messages.map for any per-call mutations.
5. Concurrency: force 20 parallel requests:
   ```
   for i in $(seq 1 20); do curl -X POST localhost:4000/chat -d '{"message":"hi","userId":"..."}' & done
   ```
   Logs should show at most 6 `[OpenAIOrchestrator] calling model=…` interleaved at any moment, remaining 14 queue silently.
6. `npx tsc --noEmit` — clean.

## Rollback

Each step is one file revert. `p-limit` dependency can stay (tiny, ~500 bytes minified).

## Acceptance

- Compile clean.
- `cacheHitRatio` > 0.4 on second+ same-user turn.
- Under 20× concurrent request burst, no more than `OPENAI_CONCURRENCY` in-flight OpenAI calls (verify via log grep).
- No change in assistant output for identical inputs between before/after (smoke test with the same prompt).

## Record in STATUS.md

```
- 2026-04-24 — Global OpenAI concurrency cap via `helpers/concurrency/openaiLimiter.ts`
  (env OPENAI_CONCURRENCY, default 6). Per-replica. Applied at all 5 OpenAI call sites.
- 2026-04-24 — Datetime moved out of the system prompt (`assistant.usecase.ts`) and
  into the user turn prefix so OpenAI's automatic prompt-prefix caching stays warm.
  Do not put time-varying content in `systemPrompt` again.
```
