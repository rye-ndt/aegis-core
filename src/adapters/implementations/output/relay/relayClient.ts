import type {
  IRelayClient,
  RelayQuote,
  RelayQuoteRequest,
} from "../../../../use-cases/interface/output/relay.interface";

const RELAY_API_URL = process.env.RELAY_API_URL ?? "https://api.relay.link";
const RELAY_QUOTE_PATH = "/quote";

export class RelayClient implements IRelayClient {
  constructor(private readonly baseUrl: string = RELAY_API_URL) {}

  async getQuote(request: RelayQuoteRequest): Promise<RelayQuote> {
    const url = `${this.baseUrl}${RELAY_QUOTE_PATH}`;
    const body = {
      user: request.user,
      recipient: request.recipient,
      originChainId: request.originChainId,
      destinationChainId: request.destinationChainId,
      originCurrency: request.originCurrency,
      destinationCurrency: request.destinationCurrency,
      amount: request.amount,
      tradeType: request.tradeType,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`RELAY_QUOTE_FAILED: HTTP ${response.status} ${text.slice(0, 200)}`);
    }

    const json = (await response.json()) as RelayQuote;
    if (!Array.isArray(json.steps)) {
      throw new Error("RELAY_QUOTE_INVALID: missing steps[]");
    }
    return json;
  }
}
