import { formatUnits } from "viem";
import { createLogger } from "../../../../helpers/observability/logger";
import { getAnkrBlockchain } from "../../../../helpers/chainConfig";
import type { IBalanceProvider, ProviderBalance } from "../../../../use-cases/interface/output/blockchain/balanceProvider.interface";

const log = createLogger("AnkrBalanceProvider");

// Format a raw bigint string to a fixed 6-decimal display, preserving precision
// for tokens with 18 decimals + large holdings (parseFloat would lose it).
function formatBalance(rawIntegerStr: string, decimals: number): string {
  let raw: bigint;
  try {
    raw = BigInt(rawIntegerStr);
  } catch {
    return "0.000000";
  }
  const human = formatUnits(raw, decimals);
  const dot = human.indexOf(".");
  if (dot === -1) return `${human}.000000`;
  return human.slice(0, dot + 7).padEnd(dot + 7, "0");
}

const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const ANKR_PUBLIC_ENDPOINT = "https://rpc.ankr.com/multichain";
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_BACKOFFS_MS = [200, 800] as const;

type AnkrAsset = {
  blockchain: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenType: string;
  contractAddress?: string | null;
  holderAddress: string;
  balance: string;
  balanceRawInteger: string;
  balanceUsd?: string | null;
  tokenPrice?: string | null;
};

type AnkrResponse = {
  jsonrpc: string;
  id: number;
  result?: { totalBalanceUsd?: string; assets: AnkrAsset[] };
  error?: { code: number; message: string };
};

export class AnkrBalanceProvider implements IBalanceProvider {
  private readonly endpoint: string;

  constructor(opts?: { apiKey?: string }) {
    if (opts?.apiKey) {
      this.endpoint = `${ANKR_PUBLIC_ENDPOINT}/${opts.apiKey}`;
    } else {
      this.endpoint = ANKR_PUBLIC_ENDPOINT;
      log.warn({ endpoint: ANKR_PUBLIC_ENDPOINT }, "ankr-api-key-missing");
    }
  }

  async getBalances(chainId: number, address: `0x${string}`): Promise<ProviderBalance[]> {
    const blockchain = getAnkrBlockchain(chainId);
    if (!blockchain) {
      throw new Error(`Chain ${chainId} is not supported by the Ankr balance API`);
    }

    const start = Date.now();
    log.debug(
      { chainId, address: `${address.slice(0, 6)}…${address.slice(-4)}`, blockchain },
      "ankr-request",
    );

    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await this.fetchOnce(blockchain, address);
        log.info({ chainId, count: result.length, durationMs: Date.now() - start }, "balances-fetched");
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          const backoffMs = RETRY_BACKOFFS_MS[attempt - 1] ?? 200;
          const status = (err as { status?: number }).status;
          const name = err instanceof Error ? err.name : undefined;
          log.warn({ status, name, attempt }, "ankr-fetch-retry");
          await new Promise<void>((r) => setTimeout(r, backoffMs));
        }
      }
    }

    log.error({ err: lastErr, chainId }, "ankr-fetch-failed");
    throw lastErr;
  }

  private async fetchOnce(blockchain: string, address: `0x${string}`): Promise<ProviderBalance[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "ankr_getAccountBalance",
          params: {
            blockchain: [blockchain],
            walletAddress: address,
            onlyWhitelisted: true,
            nativeFirst: true,
          },
          id: 1,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const httpErr = Object.assign(new Error(`Ankr HTTP ${resp.status}`), { status: resp.status });
        throw httpErr;
      }

      const body = (await resp.json()) as AnkrResponse;
      if (body.error) {
        throw new Error(`Ankr RPC error ${body.error.code}: ${body.error.message}`);
      }

      const assets = body.result?.assets ?? [];
      const balances: ProviderBalance[] = assets.map((a) => ({
        symbol: a.tokenSymbol,
        address: a.contractAddress ?? NATIVE_ADDRESS,
        decimals: a.tokenDecimals,
        balance: formatBalance(a.balanceRawInteger, a.tokenDecimals),
        rawBalance: a.balanceRawInteger,
        usdValue: a.balanceUsd != null ? parseFloat(a.balanceUsd) : null,
        isNative: a.tokenType === "NATIVE",
      }));

      balances.sort((a, b) => {
        if (a.usdValue === null && b.usdValue === null) return 0;
        if (a.usdValue === null) return 1;
        if (b.usdValue === null) return -1;
        return b.usdValue - a.usdValue;
      });

      return balances;
    } finally {
      clearTimeout(timer);
    }
  }
}
