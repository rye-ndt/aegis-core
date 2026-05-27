// `OPENAI_API_KEY` authenticates the embedding adapter against api.openai.com.
// It is the ONLY remaining direct OpenAI dependency — OpenRouter (see
// `openrouterEnv.ts`) has no embeddings endpoint, so the Pinecone tool-index
// embedding path keeps talking to OpenAI. All chat/completions adapters route
// through OpenRouter.
export const OPENAI_API_KEY: string | undefined = process.env.OPENAI_API_KEY;
