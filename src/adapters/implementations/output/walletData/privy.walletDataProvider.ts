import type {
  IWalletDataProvider,
  WalletBalance,
  WalletTransactionStatus,
  GasSpendResult,
} from "../../../../use-cases/interface/output/walletDataProvider.interface";
import { CAIP2_BY_PRIVY_NETWORK } from "../../../../helpers/chainConfig";

export class PrivyWalletDataProvider implements IWalletDataProvider {
  private readonly baseUrl = "https://api.privy.io";
  private readonly authHeader: string;

  constructor(private readonly appId: string, appSecret: string) {
    this.authHeader = "Basic " + Buffer.from(`${appId}:${appSecret}`).toString("base64");
  }

  private async privyFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        "privy-app-id": this.appId,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Privy API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  /** Resolve privyDid → embedded wallet entity ID (Privy-internal, not on-chain address) */
  private async resolveWalletId(privyDid: string): Promise<string> {
    const user = await this.privyFetch<{
      linked_accounts: Array<{ id: string; type: string; wallet_client_type?: string }>;
    }>(`/v1/users/${encodeURIComponent(privyDid)}`);

    const embedded = user.linked_accounts.find(
      (a) => a.type === "wallet" && a.wallet_client_type === "privy",
    );
    if (!embedded) throw new Error("PRIVY_NO_EMBEDDED_WALLET");
    return embedded.id;
  }

  async getBalances(privyDid: string): Promise<WalletBalance[]> {
    const walletId = await this.resolveWalletId(privyDid);
    const data = await this.privyFetch<{ data: Array<{
      chain_id: number;
      token_symbol: string;
      token_address: string | null;
      decimals: number;
      balance: string;
      balance_usd: string;
    }> }>(`/v1/wallets/${encodeURIComponent(walletId)}/balance`);

    return (data.data ?? []).map((b) => ({
      chainId: b.chain_id,
      tokenSymbol: b.token_symbol,
      tokenAddress: b.token_address,
      decimals: b.decimals,
      rawAmount: b.balance,
      usdDisplay: b.balance_usd,
    }));
  }

  async getTransactionStatus(transactionId: string): Promise<WalletTransactionStatus | null> {
    try {
      const data = await this.privyFetch<{
        id: string;
        status: string;
        transaction_hash?: string;
        chain_id?: number;
      }>(`/v1/transactions/${encodeURIComponent(transactionId)}`);

      const status = (["broadcasted", "confirmed", "failed"] as const).find(
        (s) => s === data.status,
      ) ?? "unknown";

      return {
        id: data.id,
        status,
        transactionHash: data.transaction_hash,
        chainId: data.chain_id,
      };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Privy API 404")) return null;
      throw err;
    }
  }

  async getGasSpend(privyDids?: string[], startDate?: string): Promise<GasSpendResult> {
    const params = new URLSearchParams();
    if (privyDids?.length) {
      // Privy accepts wallet_ids[] — resolve DIDs to wallet IDs if needed.
      // For now pass privyDids directly; the Privy gas_spend endpoint accepts user DID filters
      // under the query param wallet_ids[]=<id>. Adjust if Privy requires wallet entity IDs.
      privyDids.forEach((did) => params.append("wallet_ids[]", did));
    }
    if (startDate) params.set("start_date", startDate);

    const qs = params.toString();
    const data = await this.privyFetch<{ total_charged_usd: number }>(
      `/v1/apps/gas_spend${qs ? `?${qs}` : ""}`,
    );

    return { totalUsd: data.total_charged_usd ?? 0, currency: "USD" };
  }

  async rpcCall(
    privyDid: string,
    method: string,
    network: string,
    params: unknown[],
  ): Promise<unknown> {
    const walletId = await this.resolveWalletId(privyDid);
    const caip2 = CAIP2_BY_PRIVY_NETWORK[network.toLowerCase()] ?? network;

    const data = await this.privyFetch<{ result: unknown }>(
      `/v1/wallets/${encodeURIComponent(walletId)}/rpc`,
      {
        method: "POST",
        body: JSON.stringify({ method, caip2, chain_type: "ethereum", params }),
      },
    );

    return data.result;
  }
}
