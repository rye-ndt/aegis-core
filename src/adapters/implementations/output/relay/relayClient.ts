import { createHash } from "node:crypto";
import type Redis from "ioredis";
import type {
  IRelayClient,
  RelayIntentStatus,
  RelayIntentStatusResult,
  RelayQuote,
  RelayQuoteRequest,
} from "../../../../use-cases/interface/output/relay.interface";
import { makeRedisResponseCache } from "../../../../helpers/cache/redisResponseCache";
import { createLogger } from "../../../../helpers/observability/logger";

const RELAY_API_URL = process.env.RELAY_API_URL ?? "https://api.relay.link";
const RELAY_QUOTE_PATH = "/quote";
const RELAY_INTENT_STATUS_PATH = "/intents/status/v2";
const RELAY_QUOTE_CACHE_TTL_SECONDS = Number(process.env.RELAY_QUOTE_CACHE_TTL_SECONDS ?? 15);
const RELAY_STATUS_POLL_INTERVAL_MS = Number(process.env.RELAY_STATUS_POLL_INTERVAL_MS ?? 1500);

const log = createLogger("relayClient");

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

  /**
   * Relay's status string varies across versions ("success", "delivered",
   * "complete", "failure", "refund", "pending", "waiting", …). We collapse
   * to four values so callers don't bind to provider-specific strings;
   * unknown values fall through to `pending` and surface via the caller's
   * timeout.
   */
  async getIntentStatus(requestId: string): Promise<RelayIntentStatusResult> {
    const url = `${this.baseUrl}${RELAY_INTENT_STATUS_PATH}?requestId=${encodeURIComponent(requestId)}`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log.warn({ status: response.status, requestId }, "intent-status-http-error");
      throw new Error(`RELAY_STATUS_FAILED: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    const json = (await response.json().catch(() => ({}))) as {
      status?: string;
      reason?: string;
      details?: { reason?: string };
    };
    const status = normalizeStatus(json.status);
    const reason = json.reason ?? json.details?.reason;
    log.debug({ requestId, providerStatus: json.status, status }, "intent-status");
    return { status, requestId, ...(reason ? { reason } : {}) };
  }

  async awaitIntent(requestId: string, timeoutMs: number): Promise<RelayIntentStatusResult> {
    const start = Date.now();
    let last: RelayIntentStatusResult = { status: "pending", requestId };
    while (Date.now() - start < timeoutMs) {
      try {
        last = await this.getIntentStatus(requestId);
      } catch (err) {
        log.warn({ err, requestId }, "intent-status-poll-error");
      }
      if (last.status !== "pending") {
        log.info(
          { requestId, status: last.status, durationMs: Date.now() - start },
          "intent-resolved",
        );
        return last;
      }
      await sleep(RELAY_STATUS_POLL_INTERVAL_MS);
    }
    log.warn({ requestId, timeoutMs }, "intent-poll-timeout");
    return last;
  }
}

function normalizeStatus(raw: string | undefined): RelayIntentStatus {
  const s = (raw ?? "").toLowerCase();
  if (s === "success" || s === "delivered" || s === "complete" || s === "completed") return "success";
  if (s === "failure" || s === "failed" || s === "error") return "failure";
  if (s === "refund" || s === "refunded") return "refund";
  return "pending";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
