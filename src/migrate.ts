// Sanctioned `console.*` use: this script runs before the pino logger / app
// boot — see `helpers/observability/logger.ts`. Documented exception per
// `be/constructions/2026-05-05-architecture-cleanup-plan.md` Phase 7.

import "dotenv/config";
import path from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { loadJournal, readAppliedCreatedAts } from "./helpers/migrationJournal";

async function verifyLedger(pool: Pool, journalPath: string) {
  const journal = loadJournal(journalPath);
  const { set: applied } = await readAppliedCreatedAts(pool);

  const missing = journal.entries.filter((e) => !applied.has(String(e.when)));
  if (missing.length > 0) {
    const list = missing.map((e) => `  - idx ${e.idx} ${e.tag} (when=${e.when})`).join("\n");
    throw new Error(
      `[migrate] ledger verification failed: ${missing.length} journal entries were silently skipped:\n${list}\n` +
        `Likely cause: the entry's \`when\` is older than the max \`created_at\` already in drizzle.__drizzle_migrations. ` +
        `Run \`npm run db:generate\` again (the fix-journal post-step will bump monotonically), or hand-edit _journal.json.`,
    );
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const pool = new Pool({ connectionString });
  try {
    const db = drizzle(pool);
    const migrationsFolder = path.join(__dirname, "../drizzle");

    console.log("[migrate] running pending migrations…");
    await migrate(db, { migrationsFolder });
    console.log("[migrate] all migrations applied. verifying ledger…");

    await verifyLedger(pool, path.join(migrationsFolder, "meta", "_journal.json"));
    console.log("[migrate] ledger ok: every journal entry is present in drizzle.__drizzle_migrations.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
