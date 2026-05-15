// Sanctioned `console.*`: CLI-only, runs before app boot.
//
// Runs after `drizzle-kit generate`. If a journal entry exists that has NOT
// been applied to drizzle.__drizzle_migrations and whose `when` is ≤ the max
// applied `when`, bump it just above the max — drizzle's migrator orders
// entries by `when` and skips any whose `when` ≤ max(ledger.created_at).
//
// Hard rule: NEVER mutate the `when` of an entry that is already in the
// ledger. Doing so desyncs journal from ledger and either (a) makes the
// verifier fail or (b) causes drizzle to try to re-run an applied migration.

import "dotenv/config";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { loadJournal, readAppliedCreatedAts } from "../src/helpers/migrationJournal";

const journalPath = path.join(__dirname, "..", "drizzle", "meta", "_journal.json");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn("[fix-journal] DATABASE_URL not set; skipping (no ledger to consult).");
    return;
  }

  const journal = loadJournal(journalPath);
  if (journal.entries.length === 0) {
    console.log("[fix-journal] empty journal; nothing to do.");
    return;
  }

  const pool = new Pool({ connectionString });
  try {
    let applied: Set<string>;
    let maxAppliedWhen: number;
    try {
      ({ set: applied, max: maxAppliedWhen } = await readAppliedCreatedAts(pool));
    } catch (err) {
      console.warn(
        "[fix-journal] could not read drizzle.__drizzle_migrations; skipping.",
        err instanceof Error ? err.message : err,
      );
      return;
    }

    const unapplied = journal.entries.filter((e) => !applied.has(String(e.when)));
    if (unapplied.length === 0) {
      console.log("[fix-journal] all journal entries already applied; nothing to do.");
      return;
    }

    let changed = false;
    let cursor = maxAppliedWhen;
    for (const e of [...unapplied].sort((a, b) => a.when - b.when)) {
      if (e.when <= cursor) {
        const next = cursor + 1;
        console.log(`[fix-journal] bumping ${e.tag}: when ${e.when} -> ${next}`);
        e.when = next;
        changed = true;
      }
      cursor = e.when;
    }

    if (changed) {
      fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n");
      console.log("[fix-journal] _journal.json rewritten; only unapplied entries were touched.");
    } else {
      console.log("[fix-journal] unapplied entries already > max applied `when`; ok.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[fix-journal] failed:", err);
  process.exit(1);
});
