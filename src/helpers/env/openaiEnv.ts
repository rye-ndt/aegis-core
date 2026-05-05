/**
 * Single source of truth for OpenAI env reads. All other modules MUST import
 * `OPENAI_MODEL` / `OPENAI_API_KEY` from here rather than re-reading
 * `process.env.OPENAI_MODEL` themselves — divergent fallbacks across call
 * sites caused inconsistent model selection (see
 * `be/constructions/2026-05-05-architecture-cleanup-plan.md` Phase 3.1).
 *
 * Canonical default is `gpt-4o`. Schema compilation, assistant chat, and the
 * result-card interpreter all share this default unless the caller passes a
 * role-specific override env (e.g. `RESULT_CARD_INTERPRETER_MODEL`).
 */
export const OPENAI_MODEL: string = process.env.OPENAI_MODEL ?? "gpt-4o";

export const OPENAI_API_KEY: string | undefined = process.env.OPENAI_API_KEY;
