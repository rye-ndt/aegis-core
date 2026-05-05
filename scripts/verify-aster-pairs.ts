/**
 * Verifies that the Aster Diamond's `pairsV4()` is reachable and decodes
 * cleanly. Prints the live pair list (symbol + pairBase + SEC-EDGAR
 * friendly name when available).
 *
 * The pair list is now persisted to the `stock_pairs` table by the
 * `StockPairCrawlerJob` cron — this script is the boot-time read used by
 * CI to catch ABI drift before it lands in production.
 *
 * Usage:
 *   npx tsx scripts/verify-aster-pairs.ts
 */
import { AsterDiamondClient } from "../src/adapters/implementations/output/aster/asterDiamond.client";
import { AsterStockPairCrawler } from "../src/adapters/implementations/output/aster/asterStockPairCrawler";
import { createLogger } from "../src/helpers/observability/logger";

const log = createLogger("verifyAsterPairs");

(async () => {
  const client = new AsterDiamondClient();
  const crawler = new AsterStockPairCrawler(client);
  const pairs = await crawler.fetchPairs(56);
  if (pairs.length === 0) {
    throw new Error("pairsV4() returned 0 entries — ABI drift likely");
  }
  for (const p of pairs) {
    log.info(
      { symbol: p.symbol, pairBase: p.pairBase, name: p.name ?? "(unenriched)", pairType: p.pairType },
      "pair",
    );
  }
  log.info({ count: pairs.length, enriched: pairs.filter((p) => p.name).length }, "verify ok");
  process.exit(0);
})().catch((err) => {
  log.error({ err }, "verify failed");
  process.exit(1);
});
