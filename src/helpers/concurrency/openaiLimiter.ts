import pLimit from "p-limit";

export const OPENAI_CONCURRENCY = Number(process.env.OPENAI_CONCURRENCY ?? 6);

export const openaiLimiter = pLimit(OPENAI_CONCURRENCY);
