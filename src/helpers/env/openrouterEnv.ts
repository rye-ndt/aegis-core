// `OPENROUTER_API_KEY` authenticates every chat/completions adapter against
// OpenRouter's OpenAI-compatible API at `https://openrouter.ai/api/v1` (see
// `helpers/llm/openrouterClient.ts`). OpenRouter is the sole chat provider —
// the embedding adapter still talks to OpenAI directly (OpenRouter exposes no
// embeddings endpoint); that key lives in `openaiEnv.ts`.
//
// `OPENROUTER_MODEL` is the default chat model for all flows. It MUST be an
// OpenRouter `<provider>/<model>` slug (e.g. `openai/gpt-5-nano`) — a bare
// model id is not routable. `gpt-5-nano` is a reasoning-capable model; the
// `reasoning.effort` hint (attached by `withRouterHints`) is honoured by the
// router. The optional `HTTP-Referer` / `X-Title` headers surface this app in
// OpenRouter's dashboard and are passed through verbatim when set.
export const OPENROUTER_API_KEY: string | undefined =
  process.env.OPENROUTER_API_KEY;

export const OPENROUTER_BASE_URL: string =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

export const OPENROUTER_REFERER: string | undefined =
  process.env.OPENROUTER_REFERER;

export const OPENROUTER_APP_TITLE: string | undefined =
  process.env.OPENROUTER_APP_TITLE;

export const OPENROUTER_MODEL: string =
  process.env.OPENROUTER_MODEL ?? "openai/gpt-5-nano";
