/**
 * Env knobs for the result-card LLM interpreter (see
 * `be/constructions/2026-05-04-result-card-framework.md` §4 / §9).
 *
 * The interpreter is opt-in. When `RESULT_CARD_INTERPRETER_ENABLED` is not
 * exactly `"true"` (or no API key is configured), the renderer treats the
 * interpreter as "off" and just skips the optional italic note — the receipt
 * itself is unaffected.
 */
import { OPENAI_MODEL } from "./openaiEnv";

export interface ResultCardEnv {
  enabled: boolean;
  apiKey: string | undefined;
  model: string;
}

export function getResultCardEnv(): ResultCardEnv {
  return {
    enabled: process.env.RESULT_CARD_INTERPRETER_ENABLED === "true",
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.RESULT_CARD_INTERPRETER_MODEL ?? OPENAI_MODEL,
  };
}
