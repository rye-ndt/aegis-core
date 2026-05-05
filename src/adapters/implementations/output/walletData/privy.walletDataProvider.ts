import type {
  IWalletDataProvider,
  WalletTransactionStatus,
} from "../../../../use-cases/interface/output/walletDataProvider.interface";

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
}
