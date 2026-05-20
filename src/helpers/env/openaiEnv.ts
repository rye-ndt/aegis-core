// `OPENAI_API_KEY` authenticates the embedding adapter against api.openai.com.
// `OPENROUTER_API_KEY` authenticates every chat/completions adapter via
// `helpers/llm/openrouterClient.ts`. The exported `OPENAI_MODEL` symbol name
// is preserved for import-site stability but now holds an OpenRouter slug
// (e.g. `openai/gpt-5-mini`) — the `<provider>/<model>` form is required by
// OpenRouter and is NOT a bare OpenAI model id.
export const OPENAI_API_KEY: string | undefined = process.env.OPENAI_API_KEY;

export const OPENROUTER_API_KEY: string | undefined = process.env.OPENROUTER_API_KEY;
export const OPENROUTER_BASE_URL: string =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
export const OPENROUTER_REFERER: string | undefined = process.env.OPENROUTER_REFERER;
export const OPENROUTER_APP_TITLE: string | undefined = process.env.OPENROUTER_APP_TITLE;

export const OPENAI_MODEL: string = process.env.OPENAI_MODEL ?? "openai/gpt-5-nano";
