# Scaling Phase 3 — Part 2: Tavily + Relay response caching

> Prerequisites: Phase 2 shipped (Redis available cluster-wide).
> Behavior change: **tiny** — identical queries within the TTL window return cached results instead of hitting the provider. Output bytes are byte-identical. Freshness is bounded by TTL.
> Expected lift: cuts Tavily + Relay call volume by 60–90% under real usage, reduces tail latency, and removes a failure class (provider outage → no cache = global failure).

## Why

Two external providers are hit with full fan-out per user turn:

- **Tavily** (`src/adapters/implementations/output/webSearch/tavily.webSearchService.ts`) — every `web_search` tool call hits `tavily.search(...)`. Two users asking "AVAX price" in the same minute = two billable Tavily calls. Free tier is tight; paid is ~$1/1000 searches.
- **Relay** (`src/adapters/implementations/output/relay/relayClient.ts:26`) — every swap/bridge flow calls `POST /quote`. Quotes are valid for ~30 seconds server-side; the same route hashed within that window is safe to memoize.

Both are natural short-TTL caches. Redis is already provisioned and accessed via `getRedis()` in DI (`src/adapters/inject/assistant.di.ts:401`).

## Step 2.1 — Generic tiny Redis cache helper

New file `src/helpers/cache/redisResponseCache.ts`:

```ts
import type Redis from "ioredis";

export interface RedisResponseCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

export function makeRedisResponseCache(redis: Redis, namespace: string): RedisResponseCache {
  const k = (key: string) => `${namespace}:${key}`;
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = await redis.get(k(key));
      return raw ? (JSON.parse(raw) as T) : null;
    },
    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      await redis.set(k(key), JSON.stringify(value), "EX", ttlSeconds);
    },
  };
}
```

Small and tool-agnostic. No `IRedisResponseCache` port — this helper is an adapter-local concern; passing `Redis` through the existing adapter constructors is fine.

## Step 2.2 — Cache Tavily search results (5 min TTL)

Edit `src/adapters/implementations/output/webSearch/tavily.webSearchService.ts`:

```ts
import { tavily } from "@tavily/core";
import type Redis from "ioredis";
import { createHash } from "node:crypto";
import type { IWebSearchResult, IWebSearchService } from "../../../../use-cases/interface/output/webSearch.interface";
import { makeRedisResponseCache } from "../../../../helpers/cache/redisResponseCache";

const TAVILY_CACHE_TTL_SECONDS = Number(process.env.TAVILY_CACHE_TTL_SECONDS ?? 300);

export class TavilyWebSearchService implements IWebSearchService {
  private readonly client: ReturnType<typeof tavily>;
  private readonly cache?: ReturnType<typeof makeRedisResponseCache>;

  constructor(apiKey: string, redis?: Redis) {
    this.client = tavily({ apiKey });
    this.cache = redis ? makeRedisResponseCache(redis, "tavily") : undefined;
  }

  private keyFor(params: { query: string; maxResults: number }): string {
    return createHash("sha1")
      .update(`${params.maxResults}|${params.query.trim().toLowerCase()}`)
      .digest("hex");
  }

  async search(params: { query: string; maxResults: number }): Promise<IWebSearchResult[]> {
    const cacheKey = this.keyFor(params);
    if (this.cache) {
      const cached = await this.cache.get<IWebSearchResult[]>(cacheKey);
      if (cached) return cached;
    }
    const response = await this.client.search(params.query, {
      maxResults: params.maxResults,
      searchDepth: "basic",
    });
    const results: IWebSearchResult[] = response.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
    }));
    if (this.cache) {
      await this.cache.set(cacheKey, results, TAVILY_CACHE_TTL_SECONDS);
    }
    return results;
  }
}
```

### DI update

Find where `TavilyWebSearchService` is constructed in `src/adapters/inject/assistant.di.ts` (grep for `TavilyWebSearchService`) and pass `this.getRedis()`:

```ts
this._webSearchService = new TavilyWebSearchService(apiKey, this.getRedis());
```

If the DI currently wraps the service in `undefined` when the API key is missing, preserve that check.

## Step 2.3 — Cache Relay quotes (15 s TTL)

Edit `src/adapters/implementations/output/relay/relayClient.ts`:

```ts
import type Redis from "ioredis";
import { createHash } from "node:crypto";
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
```

### DI update

In `src/adapters/inject/assistant.di.ts`, find where `RelayClient` is constructed and pass `this.getRedis()`:

```ts
this._relayClient = new RelayClient(undefined, this.getRedis());
```

### TTL rationale

- **Tavily 5 min (300 s):** web search results are "newsy" — 5 min is fresh enough for crypto price summaries and stays warm for any repeated queries in a chat session.
- **Relay 15 s:** quotes go stale fast because they encode current gas + liquidity. 15 s is short enough that a re-quote happens well inside the Relay server's own quote validity window.

Both TTLs are env-tunable. Tighten if users report stale data; widen after load test validates safety.

## Step 2.4 — Env in `.env.example`

Append to `# Scaling — Phase 3`:

```
TAVILY_CACHE_TTL_SECONDS=300
RELAY_QUOTE_CACHE_TTL_SECONDS=15
```

## Cache stampede consideration

Two users searching "AVAX price" in the same 10 ms window still generate two Tavily calls (both miss the cache, both write it). For 200-user scale, that's fine — cache stampede only matters at much higher concurrency. Not worth adding a single-flight lock here.

## How to verify locally

1. `docker compose up -d redis postgres` and `npm run dev`.
2. Redis CLI in another terminal: `docker exec -it $(docker ps -qf "name=redis") redis-cli MONITOR`.
3. Trigger a web-search tool call (ask the assistant "search for latest AVAX news"). In MONITOR you'll see `GET tavily:…` (miss) → `SET tavily:… EX 300`.
4. Ask the same question again within 5 min. MONITOR shows only `GET tavily:…` — no `SET`, no outbound Tavily call.
5. For Relay: simulate via the swap capability (`/swap 1 AVAX to USDC`). First quote sets the cache; a second identical request in 15 s returns cached.
6. `KEYS tavily:*` and `KEYS relay_quote:*` confirm keys are scoped.
7. Unset `REDIS_URL`, restart — both adapters skip caching (constructors receive `undefined`), everything still works.
8. `npx tsc --noEmit` — clean.

## Rollback

Per-file revert. The new helper file can remain dead.

## Acceptance

- Compile clean.
- Cache hits visible in Redis MONITOR for repeated Tavily and Relay calls.
- No behavior change on cold path.
- Output objects are byte-identical across cached / uncached runs (JSON round-trip).

## Record in STATUS.md

```
- 2026-04-24 — Tavily (5 min) and Relay quote (15 s) responses cached in Redis
  via `helpers/cache/redisResponseCache.ts`. Keys: `tavily:{sha1(q+limit)}`,
  `relay_quote:{sha1(user+route+amount+type)}`. Caches are opt-in: adapters
  skip them when `REDIS_URL` is unset. TTLs env-tunable; tighten Tavily if
  freshness issues surface, tighten Relay if quote-staleness errors appear.
```
