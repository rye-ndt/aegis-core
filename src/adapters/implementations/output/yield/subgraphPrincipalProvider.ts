import { YIELD_PROTOCOL_ID } from "../../../../helpers/enums/yieldProtocolId.enum";
import { getAaveMarketId } from "../../../../helpers/chainConfig";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  IPrincipalProvider,
  PrincipalQuery,
} from "../../../../use-cases/interface/output/yield/IPrincipalProvider";

const log = createLogger("subgraphPrincipalProvider");

const PRINCIPAL_QUERY = `
  query Principal($user: ID!, $market: String!) {
    account(id: $user) {
      positions(where: { market: $market, side: SUPPLIER }) {
        cumulativeDepositTokenAmount
        cumulativeWithdrawTokenAmount
      }
    }
  }
`;

const SUBGRAPH_ID = "72Cez54APnySAn6h8MswzYkwaL9KjvuuKnKArnPJ8yxb";

export class SubgraphPrincipalProvider implements IPrincipalProvider {
  private readonly url: string;
  private readonly disabled: boolean;
  private authWarnLogged = false;
  /** Last call outcome: undefined = no calls yet, true = ok, false = failed. */
  private lastCallOk: boolean | undefined = undefined;

  constructor(apiKey: string) {
    this.disabled = !apiKey || apiKey.trim() === "";
    this.url = `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${SUBGRAPH_ID}`;
    if (this.disabled) {
      log.warn(
        { feature: "yield" },
        "THEGRAPH_API_KEY unset — yield principal will fall back to current balance, lifetime PnL will read ~0",
      );
    }
  }

  /** "ok" before any call has succeeded/failed and key present, "disabled" if no
   * key, "degraded" if last call failed. Used by /health. */
  status(): "ok" | "degraded" | "disabled" {
    if (this.disabled) return "disabled";
    if (this.lastCallOk === false) return "degraded";
    return "ok";
  }

  async getPrincipalRaw({ userAddress, chainId, protocolId, tokenAddress }: PrincipalQuery): Promise<bigint | null> {
    if (protocolId !== YIELD_PROTOCOL_ID.AAVE_V3) return null;
    if (this.disabled) return null;

    const market = getAaveMarketId(chainId, tokenAddress);
    if (!market) return null;

    const t0 = Date.now();
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: PRINCIPAL_QUERY,
          variables: { user: userAddress.toLowerCase(), market: market.toLowerCase() },
        }),
      });

      if (!res.ok) {
        this.lastCallOk = false;
        const host = safeHost(this.url);
        const isAuthShaped = res.status === 401 || res.status === 403;
        if (isAuthShaped && !this.authWarnLogged) {
          this.authWarnLogged = true;
          log.warn({ status: res.status, url: host }, "subgraph-auth-failed");
        } else {
          log.debug({ status: res.status, url: host }, "subgraph-fetch-failed");
        }
        return null;
      }

      const json = await res.json() as {
        data?: { account?: { positions?: Array<{ cumulativeDepositTokenAmount?: string; cumulativeWithdrawTokenAmount?: string }> } };
      };
      const positions = json?.data?.account?.positions ?? [];

      let net = 0n;
      for (const p of positions) {
        net += BigInt(p.cumulativeDepositTokenAmount ?? "0");
        net -= BigInt(p.cumulativeWithdrawTokenAmount ?? "0");
      }
      if (net < 0n) net = 0n;

      this.lastCallOk = true;
      log.debug({ durationMs: Date.now() - t0, market }, "subgraph-principal");
      return net;
    } catch (err) {
      this.lastCallOk = false;
      log.error({ err, chainId, protocolId }, "subgraph-principal-failed");
      return null;
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "subgraph";
  }
}
