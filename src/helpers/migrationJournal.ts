import fs from "fs";
import { Pool } from "pg";

// Shared helpers for `_journal.json` + `drizzle.__drizzle_migrations`.
// Drizzle stores `created_at` in the ledger equal to the journal `when`,
// so the two can be compared directly.

export type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

export type Journal = { version: string; dialect: string; entries: JournalEntry[] };

export function loadJournal(journalPath: string): Journal {
  return JSON.parse(fs.readFileSync(journalPath, "utf8"));
}

export async function readAppliedCreatedAts(
  pool: Pool,
): Promise<{ set: Set<string>; max: number }> {
  const { rows } = await pool.query<{ created_at: string }>(
    "select created_at from drizzle.__drizzle_migrations",
  );
  const set = new Set(rows.map((r) => String(r.created_at)));
  const max = rows.reduce((m, r) => (Number(r.created_at) > m ? Number(r.created_at) : m), 0);
  return { set, max };
}
