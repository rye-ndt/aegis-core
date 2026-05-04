/**
 * Verifies that every hardcoded Aster stock symbol in `AsterPairRegistry`
 * resolves on-chain on BSC.
 *
 * Usage:
 *   npx tsx scripts/verify-aster-pairs.ts
 *
 * Exit code is non-zero on mismatch — wire this into CI before merging
 * any change touching the asterAbi or pair registry.
 */
import { AsterDiamondClient } from "../src/adapters/implementations/output/aster/asterDiamond.client";
import { AsterPairRegistry } from "../src/adapters/implementations/output/aster/asterPairRegistry";
import { createLogger } from "../src/helpers/observability/logger";

const log = createLogger("verifyAsterPairs");

(async () => {
  const client = new AsterDiamondClient();
  const reg = new AsterPairRegistry(client);
  await reg.verifyAgainstChain();
  log.info({ count: reg.list().length }, "all stock pairs verified on-chain");
  process.exit(0);
})().catch((err) => {
  log.error({ err }, "verify failed");
  process.exit(1);
});
