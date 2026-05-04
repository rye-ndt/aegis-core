/**
 * Flushes `yield:apy_series:*` Redis keys.
 *
 * Run after changing the APY math in `aaveV3Adapter.rayToApy` — historical
 * samples written by the previous formula will otherwise bias the EMA in
 * `yieldPoolRanker` for ~7 days (84 samples × 2h pool scan cadence).
 *
 * Usage:
 *   npx tsx scripts/flush-yield-apy-history.ts
 *
 * Reads `REDIS_URL` from env. SCANs `yield:apy_series:*` and deletes each
 * matching key in batches. Prints the total count.
 */
import "dotenv/config";
import Redis from "ioredis";
import { createLogger } from "../src/helpers/observability/logger";

const log = createLogger("flushYieldApyHistory");
const PATTERN = "yield:apy_series:*";
const SCAN_COUNT = 200;

(async () => {
  const url = process.env.REDIS_URL;
  if (!url) {
    log.error("REDIS_URL is not set");
    process.exit(1);
  }
  const redis = new Redis(url, { lazyConnect: false });

  let cursor = "0";
  let deleted = 0;
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", PATTERN, "COUNT", SCAN_COUNT);
    cursor = next;
    if (batch.length > 0) {
      await redis.del(...batch);
      deleted += batch.length;
    }
  } while (cursor !== "0");

  log.info({ deleted, pattern: PATTERN }, "flush complete");
  await redis.quit();
  process.exit(0);
})().catch((err) => {
  log.error({ err }, "flush failed");
  process.exit(1);
});
