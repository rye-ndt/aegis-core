/**
 * One-off verification script (§4 of self-derived-sca plan).
 *
 * Compares deriveScaAddress(eoa, chainId) against every onboarded user's
 * stored smart_account_address. 100% match is required before flipping
 * recipient resolution to derivation-fallback.
 *
 * Usage:
 *   CHAIN_ID=43114 DATABASE_URL=postgres://... npx tsx scripts/verify-sca-derivation.ts
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { isNotNull, and } from "drizzle-orm";
import pg from "pg";
import { userProfiles } from "../src/adapters/implementations/output/sqlDB/schema";
import { deriveScaAddress } from "../src/helpers/deriveScaAddress";
import { CHAIN_CONFIG } from "../src/helpers/chainConfig";
import { createLogger } from "../src/helpers/observability/logger";

const log = createLogger("verifyScaDerivation");

async function main(): Promise<void> {
  const chainId = CHAIN_CONFIG.chainId;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  const rows = await db
    .select({
      userId: userProfiles.userId,
      eoaAddress: userProfiles.eoaAddress,
      smartAccountAddress: userProfiles.smartAccountAddress,
    })
    .from(userProfiles)
    .where(and(isNotNull(userProfiles.eoaAddress), isNotNull(userProfiles.smartAccountAddress)));

  log.info({ total: rows.length, chainId }, "rows-loaded");

  let matched = 0;
  let mismatched = 0;
  const mismatches: Array<{ userId: string; eoa: string; stored: string; derived: string }> = [];

  for (const row of rows) {
    const eoa = row.eoaAddress as `0x${string}`;
    const stored = (row.smartAccountAddress as string).toLowerCase();
    try {
      const derived = (await deriveScaAddress(eoa, chainId)).toLowerCase();
      if (derived === stored) {
        matched++;
      } else {
        mismatched++;
        mismatches.push({ userId: row.userId, eoa, stored, derived });
      }
    } catch (err) {
      log.error({ err, userId: row.userId, eoa }, "derivation-failed");
      mismatched++;
    }
  }

  log.info({ matched, mismatched, total: rows.length }, "verification-complete");

  if (mismatches.length > 0) {
    for (const m of mismatches) {
      log.warn(m, "sca-mismatch");
    }
  }

  await pool.end();

  if (mismatched > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exitCode = 1;
});
