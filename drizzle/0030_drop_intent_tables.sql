-- GATED: do not run until <release tag>.
--
-- This migration is intentionally NOT registered in `drizzle/meta/_journal.json`
-- so `migrate.ts` will skip it. Only register it (append the entry to the journal
-- + add the matching `_snapshot.json` via `drizzle-kit generate`) once the
-- preceding cleanup PRs (Phase 1.1, 1.2, 1.4) have been deployed and one full
-- release cycle has confirmed no read regressions on transfer history.
--
-- Background (be/constructions/2026-05-05-architecture-cleanup-plan.md, Phase 1.3):
--   - The `intents` table has been write-free since the 2026-05-05 NL-unification.
--   - The `intent_executions` table has been write-free since the same change;
--     its only reader (transferHistory enrichment) was removed in Phase 1.2.
--   - `loyalty_points_ledger.intent_execution_id` has no FK constraint, so
--     orphaned values do not block this DROP. Existing rows stay as-is and
--     can be cleaned up in a follow-up.

DROP TABLE IF EXISTS "intent_executions";--> statement-breakpoint
DROP TABLE IF EXISTS "intents";
