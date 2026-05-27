/**
 * Env knobs for the result-card LLM interpreter (see
 * `be/constructions/2026-05-04-result-card-framework.md` §4 / §9).
 *
 * The interpreter is opt-in. When `RESULT_CARD_INTERPRETER_ENABLED` is not
 * exactly `"true"` (or no API key is configured), the renderer treats the
 * interpreter as "off" and just skips the optional italic note — the receipt
 * itself is unaffected.
 */
import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from "./openrouterEnv";

export interface ResultCardEnv {
  enabled: boolean;
  // `available` reflects whether the underlying LLM provider is configured.
  // That's `OPENROUTER_API_KEY` — the interpreter reads the key from the
  // OpenRouter client factory; this flag exists only so the DI gate can
  // short-circuit when no key is set.
  available: boolean;
  model: string;
}

export function getResultCardEnv(): ResultCardEnv {
  return {
    enabled: process.env.RESULT_CARD_INTERPRETER_ENABLED === "true",
    available: !!OPENROUTER_API_KEY,
    model: process.env.RESULT_CARD_INTERPRETER_MODEL ?? OPENROUTER_MODEL,
  };
}
