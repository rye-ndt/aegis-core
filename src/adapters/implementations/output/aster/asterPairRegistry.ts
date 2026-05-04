import type { IStockPairRegistry } from "../../../../use-cases/interface/output/stocks/stockPair.interface";
import type { AsterDiamondClient } from "./asterDiamond.client";
import { ASTER_PAIRS_ABI } from "./asterAbi";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("asterPairRegistry");

/**
 * Hardcoded list of supported tokenized stocks. Hardcoding is intentional —
 * we only ship support for symbols we've explicitly tested. The full
 * `pairBase` addresses must be filled in via the boot-time
 * `verifyAgainstChain()` call (which decodes `pairsV4()` and matches by
 * symbol from the on-chain pair name like "AAPL/USD").
 *
 * NOTE: pairBase placeholders are filled at adapter construction by reading
 * the live diamond. Until verifyAgainstChain() runs successfully, `resolve`
 * returns null for each symbol — keeping us fail-closed on the open path.
 */
const SUPPORTED_SYMBOLS = ["AAPL", "AMZN", "TSLA", "NVDA", "GOOG", "META"] as const;
type SupportedSymbol = (typeof SUPPORTED_SYMBOLS)[number];

interface PairView {
  name: string;
  pairBase: `0x${string}`;
  // ...other fields ignored
}

function extractSymbol(name: string): string {
  return name.split("/")[0]?.trim().toUpperCase() ?? "";
}

export class AsterPairRegistry implements IStockPairRegistry {
  private readonly resolved = new Map<SupportedSymbol, `0x${string}`>();

  constructor(private readonly diamond: AsterDiamondClient) {}

  resolve(symbol: string): `0x${string}` | null {
    const upper = symbol.trim().toUpperCase() as SupportedSymbol;
    return this.resolved.get(upper) ?? null;
  }

  symbols(): readonly string[] {
    return SUPPORTED_SYMBOLS;
  }

  list(): ReadonlyArray<{ symbol: string; pairBase: `0x${string}` }> {
    const out: Array<{ symbol: string; pairBase: `0x${string}` }> = [];
    for (const sym of SUPPORTED_SYMBOLS) {
      const pairBase = this.resolved.get(sym);
      if (pairBase) out.push({ symbol: sym, pairBase });
    }
    return out;
  }

  async verifyAgainstChain(): Promise<void> {
    const live = (await this.diamond.publicClient.readContract({
      address: this.diamond.diamondAddress,
      abi: ASTER_PAIRS_ABI,
      functionName: "pairsV4",
    })) as readonly PairView[];

    const liveBySymbol = new Map<string, `0x${string}`>();
    for (const p of live) {
      const sym = extractSymbol(p.name);
      if (!sym) continue;
      liveBySymbol.set(sym, p.pairBase.toLowerCase() as `0x${string}`);
    }

    const missing: string[] = [];
    for (const sym of SUPPORTED_SYMBOLS) {
      const pb = liveBySymbol.get(sym);
      if (!pb) {
        missing.push(sym);
        continue;
      }
      this.resolved.set(sym, pb);
    }

    if (missing.length > 0) {
      log.error(
        { missing, liveCount: live.length },
        "stock pairs missing on chain",
      );
      throw new Error(
        `aster diamond missing required stock pairs: ${missing.join(", ")}`,
      );
    }

    log.info(
      { count: this.resolved.size, liveCount: live.length },
      "pair registry verified",
    );
  }
}
