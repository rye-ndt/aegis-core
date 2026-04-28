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

  constructor(apiKey: string) {
    this.url = `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${SUBGRAPH_ID}`;
  }

  async getPrincipalRaw({ userAddress, chainId, protocolId, tokenAddress }: PrincipalQuery): Promise<bigint | null> {
    if (protocolId !== YIELD_PROTOCOL_ID.AAVE_V3) return null;

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
        log.warn({ status: res.status, url: this.url }, "subgraph-fetch-failed");
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

      log.debug({ durationMs: Date.now() - t0, market }, "subgraph-principal");
      return net;
    } catch (err) {
      log.error({ err, chainId, protocolId }, "subgraph-principal-failed");
      return null;
    }
  }
}
