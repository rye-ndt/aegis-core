// Sanctioned `console.*` use: this script runs before the pino logger / app
// boot — see `helpers/observability/logger.ts`. Documented exception per
// `be/constructions/2026-05-05-architecture-cleanup-plan.md` Phase 7.

import "dotenv/config";
import path from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  console.log("[migrate] running pending migrations…");
  await migrate(db, { migrationsFolder: path.join(__dirname, "../drizzle") });
  console.log("[migrate] all migrations applied.");

  await pool.end();
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
