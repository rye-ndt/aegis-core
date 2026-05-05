/**
 * Single source of truth for Telegram-side env knobs. The Telegram input
 * handler and the Telegram artifact renderer both need `MINI_APP_URL` to
 * build mini-app launch buttons; before this lived as duplicate
 * `process.env.MINI_APP_URL` reads in each module — see
 * `be/constructions/2026-05-05-architecture-cleanup-plan.md` Phase 3.3.
 *
 * `undefined` when unset — callers must handle the missing-config branch
 * (typically by suppressing the mini-app button).
 */
export const MINI_APP_URL: string | undefined = process.env.MINI_APP_URL;
