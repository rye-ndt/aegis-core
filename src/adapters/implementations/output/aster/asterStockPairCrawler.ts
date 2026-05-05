import type {
  IStockPairCrawler,
  StockPairCrawl,
} from "../../../../use-cases/interface/output/stocks/stockPairCrawler.interface";
import type { AsterDiamondClient } from "./asterDiamond.client";
import { ASTER_PAIRS_ABI } from "./asterAbi";
import { getSecTickerNameMap } from "./secCompanyTickers";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("asterStockPairCrawler");

interface PairView {
  name: string;          // e.g. "AAPL/USD"
  pairBase: `0x${string}`;
  // ...other fields ignored
}

function extractSymbol(name: string): string {
  return name.split("/")[0]?.trim().toUpperCase() ?? "";
}

/**
 * Reads `pairsV4()` from the Aster Diamond and joins each entry with the
 * SEC EDGAR `ticker → company name` map. Pairs Aster lists that have no SEC
 * match (forex, crypto, non-US equities) are still returned with `name`
 * undefined so the ingestion path can persist them; the registry's
 * resolveByQuery ranking ignores rows whose `name` equals their symbol.
 */
export class AsterStockPairCrawler implements IStockPairCrawler {
  constructor(private readonly diamond: AsterDiamondClient) {}

  async fetchPairs(_chainId: number): Promise<StockPairCrawl[]> {
    const start = Date.now();
    const live = (await this.diamond.publicClient.readContract({
      address: this.diamond.diamondAddress,
      abi: ASTER_PAIRS_ABI,
      functionName: "pairsV4",
    })) as readonly PairView[];
    log.debug(
      { count: live.length, durationMs: Date.now() - start },
      "pairs fetched",
    );

    const secNames = await getSecTickerNameMap();

    const out: StockPairCrawl[] = [];
    for (const p of live) {
      const sym = extractSymbol(p.name);
      if (!sym) continue;
      const name = secNames.get(sym);
      out.push({
        symbol: sym,
        pairBase: p.pairBase.toLowerCase() as `0x${string}`,
        name,
      });
    }
    log.info(
      { count: out.length, enriched: out.filter((p) => p.name).length },
      "pairs assembled",
    );
    return out;
  }
}
