# drizzle migrations — status

Source of truth for how migrations behave in this repo. Read before generating, applying, or debugging a migration.

## Gotcha — silently-skipped migrations due to out-of-order `when` timestamps

**Symptom:** `npm run db:migrate` prints
```
[migrate] running pending migrations…
[migrate] all migrations applied.
```
…but the new column / table never appears in Postgres. `psql -c "\d <table>"` shows nothing was changed. No error, no log line, no DDL executed.

**Cause:** drizzle's migrator decides what to apply by comparing each entry's `when` field in `drizzle/meta/_journal.json` against the latest `created_at` (a unix-ms integer) in the DB's `drizzle.__drizzle_migrations` tracking table. **Any journal entry whose `when` is older than the newest applied `created_at` is treated as historical and silently skipped — even if its hash isn't in the tracking table.**

This repo trips that trap because:
1. Several older journal entries (idx 27/28/29 at the time of writing) carry hand-rolled **future** timestamps in mid-May 2026 (e.g. `1778716800000`).
2. `drizzle-kit generate` stamps new entries with the real wall-clock `Date.now()`, which is naturally smaller than those fake-future values.
3. Result: a freshly generated migration is born "in the past" relative to what the DB thinks is current, and the migrator skips it without warning.

The tracking table is also sparse (most early migrations were applied via `db:push`, not the migrator), which makes the "latest applied" comparison rely entirely on whatever handful of rows are present — usually the bogus-future ones.

**Fix when you hit this:** bump the new entry's `when` in `drizzle/meta/_journal.json` to be **strictly greater** than the largest `created_at` in `drizzle.__drizzle_migrations`. Then re-run `npm run db:migrate`. Verify with `psql -c "\d <table>"`.

```sh
# Find the watermark you need to beat:
psql "$DATABASE_URL" -c "SELECT MAX(created_at) FROM drizzle.__drizzle_migrations;"
```

**Do NOT** bypass by running the SQL directly against the DB — CLAUDE.md forbids it, and the tracking table will then be inconsistent with reality, recreating this same trap on the next migration.

**Long-term cleanup (not yet done):** rewrite the bogus future `when` values in `_journal.json` back to their true generation times so newly-generated migrations sort naturally after them. Touching this file is risky on a shared branch — coordinate before doing it.

## Conventions

- All schema changes go through `npm run db:generate` (drizzle-kit). Never hand-write a migration file.
- All applies go through `npm run db:migrate` (which runs `src/migrate.ts`, the node-postgres migrator). Never use `db:push` against a shared database — it bypasses the journal and leaves the tracking table out of sync, which is what created the gotcha above.
- The migrator script lives at `be/src/migrate.ts` and is one of the two sanctioned `console.*` users in the codebase (it runs before pino is wired up).
