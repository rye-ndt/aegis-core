/**
 * Single source of truth for assistant-loop env knobs. `MAX_TOOL_ROUNDS`
 * caps the LLM tool-call loop in both the chat assistant and the
 * compile-loops in send/swap capabilities; previously each module re-read
 * `process.env.MAX_TOOL_ROUNDS` with the same default — see
 * `be/constructions/2026-05-05-architecture-cleanup-plan.md` Phase 3.2.
 */
const DEFAULT_MAX_TOOL_ROUNDS = 10;

export const MAX_TOOL_ROUNDS: number = parseInt(
  process.env.MAX_TOOL_ROUNDS ?? String(DEFAULT_MAX_TOOL_ROUNDS),
  10,
);
