import { createHash } from "node:crypto";
import type Redis from "ioredis";
import type {
  IRelayClient,
  RelayQuote,
  RelayQuoteRequest,
} from "../../../../use-cases/interface/output/relay.interface";
import { makeRedisResponseCache } from "../../../../helpers/cache/redisResponseCache";

const RELAY_API_URL = process.env.RELAY_API_URL ?? "https://api.relay.link";
const RELAY_QUOTE_PATH = "/quote";
const RELAY_QUOTE_CACHE_TTL_SECONDS = Number(process.env.RELAY_QUOTE_CACHE_TTL_SECONDS ?? 15);

export class RelayClient implements IRelayClient {
  private readonly cache?: ReturnType<typeof makeRedisResponseCache>;

  constructor(
    private readonly baseUrl: string = RELAY_API_URL,
    redis?: Redis,
  ) {
    this.cache = redis ? makeRedisResponseCache(redis, "relay_quote") : undefined;
  }

  private keyFor(r: RelayQuoteRequest): string {
    const normalized = [
      r.user.toLowerCase(),
      r.recipient.toLowerCase(),
      r.originChainId,
      r.destinationChainId,
      r.originCurrency.toLowerCase(),
      r.destinationCurrency.toLowerCase(),
      r.amount,
      r.tradeType,
    ].join("|");
    return createHash("sha1").update(normalized).digest("hex");
  }

  async getQuote(request: RelayQuoteRequest): Promise<RelayQuote> {
    const cacheKey = this.keyFor(request);
    if (this.cache) {
      const cached = await this.cache.get<RelayQuote>(cacheKey);
      if (cached) return cached;
    }

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

    if (this.cache) {
      await this.cache.set(cacheKey, json, RELAY_QUOTE_CACHE_TTL_SECONDS);
    }
    return json;
  }
}
