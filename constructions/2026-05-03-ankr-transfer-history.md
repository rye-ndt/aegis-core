# Implementation plan: Ankr-backed user transfer history

**Status:** Implemented (2026-05-04)
**Author / date:** 2026-05-03
**Scope:** Backend only (`be/src/`). FE plan lives at `fe/privy-auth/constructions/2026-05-03-ankr-transfer-history.md`.

---

## 1. Goal

Give every Aegis user a **complete cross-source transfer history** for their Smart Contract Account — outgoing *and* incoming, regardless of whether the counterparty is an Aegis user — without owning a chain ingester. Two consumers, one source:

1. **REST** `GET /transfers` — Bearer-Privy authenticated, used by the FE Activity view.
2. **Agent tool** `get_transfer_history` — registered in the system tool provider, called when the LLM detects a "history / spend / receive / activity" intent (e.g. *"what did I spend last week"*, *"who paid me yesterday"*).

Both surfaces share **one port**, **one adapter** (Ankr), and **one Redis cache layer** so the free-tier quota cannot be exhausted by a single user, an open mini-app tab, or an over-eager agent loop.

**Non-goals**

- Building an in-house chain ingester. Out of scope; deferred until Ankr free tier becomes a real cost ceiling.
- ~~Decoding swap/yield internals into "labelled activity"~~ **Now in scope (resolved §15.2):** rows produced by an Aegis intent flow are tagged with a short `label` derived from `intent_executions.solverUsed` (e.g. `"swap via Relay"`, `"send"`). Non-Aegis txs leave `label = null`. Decoding internal protocol semantics ("Deposited 10 USDC into Aave") is still out of scope.
- Multi-chain aggregation. v1 serves the configured `chainId` only, matching `PortfolioUseCase`.

---

## 2. Why Ankr (re-affirmed)

- Already integrated (`AnkrBalanceProvider`, `ANKR_API_KEY` env var, chain mapping in `chainConfig.ts`'s `ankrBlockchain`). Zero new vendor surface.
- `ankr_getTransactionsByAddress` returns native + ERC-20 transfers in one paginated call, decoded, with timestamps.
- Free tier covers MVP traffic when paired with the cache layer in §7.
- The port boundary in §3 keeps the door open for a future `RpcTransferHistoryProvider` (or in-house ingester) without touching callers.

---

## 3. Architectural placement (hexagonal)

```
use-cases/interface/output/blockchain/
  transferHistoryProvider.interface.ts        (NEW — port)

adapters/implementations/output/transferHistory/
  ankrTransferHistoryProvider.ts              (NEW — adapter)
  cachedTransferHistoryProvider.ts            (NEW — Redis decorator)

adapters/implementations/output/cache/
  redis.transferHistory.ts                    (NEW — cache adapter)

use-cases/interface/output/cache/
  transferHistory.cache.ts                    (NEW — cache port)

use-cases/interface/input/
  transferHistory.interface.ts                (NEW — input port)

use-cases/implementations/
  transferHistory.usecase.ts                  (NEW)

adapters/implementations/output/tools/
  getTransferHistory.tool.ts                  (NEW — agent tool)

adapters/implementations/input/http/
  httpServer.ts                               (EDIT — add GET /transfers route)
```

The use case depends only on `ITransferHistoryProvider` (which the cache decorator wraps the Ankr adapter behind) and a `ITransferHistoryCache` for the per-user rate guard. No infra detail leaks into the tool or the HTTP route.

---

## 4. Port contract

`be/src/use-cases/interface/output/blockchain/transferHistoryProvider.interface.ts`

```ts
export type TransferDirection = "in" | "out" | "self";

export type TransferRecord = {
  chainId: number;
  txHash: `0x${string}`;
  logIndex: number | null;       // null for native / tx-level transfers
  blockNumber: number;
  timestampEpoch: number;        // seconds
  direction: TransferDirection;  // relative to the queried address
  from: `0x${string}`;
  to: `0x${string}`;
  tokenAddress: `0x${string}`;   // NATIVE_PSEUDO_ADDRESS for native
  tokenSymbol: string;
  tokenDecimals: number;
  isNative: boolean;
  amountRaw: string;             // bigint as decimal string
  amountFormatted: string;       // toFixed(6) for parity with portfolio rows
  usdValue: number | null;
  label?: string | null;         // §9 labelling — set when txHash matches an intent_executions row
};

export type TransferHistoryQuery = {
  chainId: number;
  address: `0x${string}`;
  fromEpoch?: number;            // inclusive lower bound
  toEpoch?: number;              // inclusive upper bound
  direction?: TransferDirection; // filter; omit for all
  limit: number;                 // 1..100, caller-clamped
  cursor?: string;               // opaque, provider-defined
};

export type TransferHistoryPage = {
  items: TransferRecord[];
  nextCursor: string | null;
};

export interface ITransferHistoryProvider {
  getHistory(q: TransferHistoryQuery): Promise<TransferHistoryPage>;
}
```

Cache port — `be/src/use-cases/interface/output/cache/transferHistory.cache.ts`:

```ts
export interface ITransferHistoryCache {
  /** Return a cached page, or null on miss / parse error. */
  get(key: string): Promise<TransferHistoryPage | null>;
  /** TTL in seconds; key is opaque to caller. */
  set(key: string, page: TransferHistoryPage, ttlSec: number): Promise<void>;

  /**
   * Per-user rate guard. Returns true if `userId` may issue another upstream Ankr
   * call right now, false if the per-window quota is exhausted.
   * Implementations use a sliding-window or fixed-window counter in Redis.
   */
  acquireUpstreamSlot(userId: string): Promise<boolean>;
}
```

---

## 5. Ankr adapter

`be/src/adapters/implementations/output/transferHistory/ankrTransferHistoryProvider.ts`

### 5.1 Endpoint

`POST https://rpc.ankr.com/multichain/<ANKR_API_KEY>` (re-uses `ANKR_API_KEY` env from balance work; no new secret).

```json
{
  "jsonrpc": "2.0",
  "method": "ankr_getTransactionsByAddress",
  "params": {
    "blockchain": ["avalanche"],
    "address": "0x…",
    "fromTimestamp": 1735689600,
    "toTimestamp":   1735776000,
    "pageSize": 50,
    "pageToken": "<opaque>",
    "descOrder": true,
    "includeLogs": true
  },
  "id": 1
}
```

For ERC-20 specifics we additionally call `ankr_getTokenTransfers` and merge — Ankr's `getTransactionsByAddress` includes transfers but not always the decoded token metadata (symbol/decimals); `getTokenTransfers` provides those. The adapter merges the two on `(txHash, logIndex)`, preferring the token-transfer row when both are present.

### 5.2 Chain mapping

Re-use `getAnkrBlockchain(chainId)` from `helpers/chainConfig.ts`. If null (e.g. Fuji 43113), throw `UnsupportedChainError` — caller surfaces "history not available on this chain".

### 5.3 Mapping Ankr → `TransferRecord`

- Native transfers: `tokenAddress = NATIVE_PSEUDO_ADDRESS`, `isNative = true`, decimals/symbol via `getNativeTokenInfo(chainId)` (single source of truth — no inline chain-specific defaults).
- ERC-20: take Ankr's `contractAddress`, `tokenSymbol`, `tokenDecimals` verbatim; lowercase `contractAddress`, `from`, `to`.
- `direction` derived once at adapter boundary by comparing the queried `address` (lowercased) against `from`/`to`. `from === to === address` → `"self"`.
- `amountFormatted = (Number(rawBalance) / 10 ** decimals).toFixed(6)` — parity with portfolio rows.
- Sort merged result by `(blockNumber desc, logIndex desc)` so the merge is deterministic.

### 5.4 Networking

- `fetch` + `AbortController`, 8 s timeout per call. The merge does **two** upstream calls; both must complete inside the budget — kick them off in parallel with `Promise.all`.
- One retry on 5xx / network error (200 ms → 800 ms backoff). After retry, throw — the use case surfaces a 503 / agent surfaces "history unavailable, try again".
- Never log `ANKR_API_KEY`. Truncate addresses in `debug` events: `addr.slice(0,6)+'…'+addr.slice(-4)`.

### 5.5 Logging (per `CLAUDE.md`)

`const log = createLogger('AnkrTransferHistoryProvider')`

```ts
log.debug({ chainId, address, blockchain, fromEpoch, toEpoch, limit }, "ankr-history-request");
log.warn({ status, url, attempt }, "ankr-history-retry");
log.error({ err, chainId }, "ankr-history-failed");
log.info({ chainId, count: items.length, durationMs }, "history-fetched");
```

---

## 6. Cache + rate guards (sized for <1k users on Ankr free tier)

`adapters/implementations/output/transferHistory/cachedTransferHistoryProvider.ts` is a port-shaped decorator. Three Redis-backed mechanisms, applied in order: **cache lookup → per-user gate → global gate → upstream call → fill cache**.

```ts
class CachedTransferHistoryProvider implements ITransferHistoryProvider {
  constructor(
    private readonly inner: ITransferHistoryProvider,
    private readonly cache: ITransferHistoryCache,
    private readonly userId: string,                  // bound per request via factory
    private readonly cfg = {
      pageTtlSecRecent: 60,   // cursor=∅
      pageTtlSecOlder:  300,  // cursor!=∅, immutable past finality
      staleTtlSec:      900,  // serve stale on global-gate miss
      perUserRpm:       3,    // tightened from initial 6 — see §6.4
    },
  ) {}

  async getHistory(q: TransferHistoryQuery): Promise<TransferHistoryPage> {
    const key = buildCacheKey(q);                          // §6.1

    const fresh = await this.cache.get(key);
    log.debug({ choice: fresh ? 'hit' : 'miss', key }, "history-cache");
    if (fresh) return fresh;

    if (!(await this.cache.acquireUserSlot(this.userId, this.cfg.perUserRpm))) {
      log.warn({ userId: this.userId }, "history-rate-limited-user");
      throw new RateLimitedError('transfer-history-rate-limited-user');
    }

    if (!(await this.cache.acquireGlobalSlot())) {
      // Global Ankr quota near cap → serve stale instead of erroring.
      const stale = await this.cache.getStale(key);
      log.warn({ stale: !!stale }, "history-rate-limited-global");
      if (stale) return stale;
      throw new RateLimitedError('transfer-history-rate-limited-global');
    }

    const page = await this.inner.getHistory(q);
    const ttl = q.cursor ? this.cfg.pageTtlSecOlder : this.cfg.pageTtlSecRecent;
    await this.cache.setWithStale(key, page, ttl, this.cfg.staleTtlSec);
    return page;
  }
}
```

### 6.1 Cache-key normalization (critical for the agent path)

The LLM generates slightly different `fromEpoch`/`toEpoch` for the same intent on different turns ("last week" → varying epochs). Without normalization, every turn cache-misses and burns two upstream calls.

**Bucket** all timestamps in the cache key (not in the upstream call) to UTC-day boundaries:

```ts
function buildCacheKey(q: TransferHistoryQuery): string {
  const fromBucket = q.fromEpoch == null ? 0 : floorToUtcDay(q.fromEpoch);
  const toBucket   = q.toEpoch   == null ? 0 : ceilToUtcDay(q.toEpoch);
  return `txhist:v1:${q.chainId}:${q.address.toLowerCase()}:${q.direction ?? 'all'}:` +
         `${fromBucket}:${toBucket}:${q.limit}:${q.cursor ?? ''}`;
}
```

This means *"what did I spend last week"* asked at 14:00 and again at 14:30 hit the same cache entry. The upstream call still uses the precise epochs, so day-boundary jitter at the edges is acceptable (the user is asking about a fuzzy window anyway). Bumping the cache schema requires bumping the `v1` prefix.

### 6.2 Per-user rate guard

Sliding-window counter via Redis `INCR` + `EXPIRE`. Key `txhist:rl:user:<userId>:<minuteBucket>`. Default **3 upstream calls / user / minute** (configurable via env `TRANSFER_HISTORY_RPM_USER`). Each cursor page counts as one call; cache hits don't. On exhaustion: **throw** `RateLimitedError` — this is intentional self-protection against an agent loop that retries.

### 6.3 Global upstream gate

Token-bucket-shaped Redis counter (`INCR` on `txhist:rl:global:<secondBucket>` with `EXPIRE 2`) capped at **10 upstream calls / second** by default (env `TRANSFER_HISTORY_RPS_GLOBAL`). Sized for Ankr Advanced free tier (~30 rps shared with the existing balance provider; we leave headroom). On exhaustion: **serve stale** (`getStale(key)` reads a longer-lived companion key written alongside the fresh entry — see §6.5). If no stale entry exists either, throw `RateLimitedError`.

The global gate is what actually saves the free tier when traffic spikes; the per-user gate stops one user from monopolizing it.

### 6.4 Sizing math (1k users)

- Worst-case page-view storm: 1k users open Activity simultaneously after a deploy. With cache cold, that's 1k user-side slots × 1 call each = 1k upstream-side requests, each emitting **2** Ankr calls. Global gate at 10 rps drains this in ~200 s. Mini app already shows a skeleton during loading; users behind the gate get either a cached/stale page or a 429 banner.
- Steady state: a typical user opens Activity ≤2× per session and the agent calls `get_transfer_history` ≤1× per relevant turn. With `pageTtlSecRecent=60` and the day-bucketed cache key, **expected upstream RPS for 1k DAU stays well below 1 rps**.
- Per-user `perUserRpm=3` is enough headroom for *open tab → toggle filter → ask agent* in the same minute, while bounding a runaway loop to 6 Ankr calls/min/user.

### 6.5 Cache adapter — `adapters/implementations/output/cache/redis.transferHistory.ts`

- **Fresh pages:** `SETEX txhist:<key> <ttl> <json>` — TTL from §6 config.
- **Stale companion:** alongside every fresh write, `SETEX txhist:stale:<key> 900 <json>`. Read by `getStale(key)` only when the global gate refuses a slot. The stale layer is what makes the system feel non-broken when Ankr is slow / gated.
- **Per-user counter:** `INCR txhist:rl:user:<userId>:<minute>` with `EXPIRE 70`. Compare-and-throw at `perUserRpm`.
- **Global counter:** `INCR txhist:rl:global:<second>` with `EXPIRE 2`. Compare-and-degrade at `rpsGlobal`.
- All Redis ops are best-effort: on Redis failure, log `error { err }` and **skip the cache layer** (do *not* block the request — this is operational state, not durable). The per-user / global gates open in this degraded mode; safe at <1k scale.

---

## 7. Use case

`be/src/use-cases/interface/input/transferHistory.interface.ts`:

```ts
export type GetHistoryInput = {
  userId: string;
  fromEpoch?: number;
  toEpoch?: number;
  direction?: TransferDirection;
  limit?: number;     // default 25, max 100
  cursor?: string;
};

export interface ITransferHistoryUseCase {
  getHistory(input: GetHistoryInput): Promise<TransferHistoryPage>;
}
```

`be/src/use-cases/implementations/transferHistory.usecase.ts`:

- Looks up `userProfileDB.findByUserId(userId)` for the SCA. No SCA → return empty page (matches `getPortfolio` convention of "registration not complete").
- Clamps `limit` to `[1, 100]`, defaults to 25.
- Calls `transferHistoryProviderFactory(userId).getHistory({...})`. Factory binds `userId` into the cached decorator (so the rate guard is per-user, not per-process).
- **Label enrichment (resolved §15.2):** after the page returns, the use case calls `intentExecutionDB.findByTxHashes(userId, txHashes)` (single batched lookup) and tags matching rows with a short `label` derived from `solverUsed` (`buildLabel()` maps the raw solver id to one of `"swap via Relay" | "swap via <id>" | "send" | "yield via <id>" | "rewards claim" | "via <id>"`). `intentExecutionDB` is **optional** on the constructor — when omitted (tests, future surfaces), enrichment is skipped silently. Lookup failures are logged at `warn` and never block delivery.
- `try/catch` → maps `RateLimitedError` to a 429-shaped result, `UnsupportedChainError` to a domain error the HTTP layer turns into 400. All other errors are logged with `log.error({ err, userId }, ...)` and re-thrown.
- `log.info({ step: 'started'/'succeeded'/'failed', userId, requestId, durationMs, count })` per CLAUDE.md.

---

## 8. HTTP route — `GET /transfers`

Add to `httpServer.ts` `exactRoutes`:

```ts
"GET /transfers": (req, res, url) => this.handleGetTransfers(req, res, url),
```

Handler:

- Auth: `requirePrivyUser(req)` — same Bearer-Privy guard used by `/portfolio`, `/loyalty/history`, etc.
- Query params (parsed via zod for safety): `fromEpoch?`, `toEpoch?`, `direction?` ∈ `{in,out,self}`, `limit?` (1..100), `cursor?`.
- 200 body:

  ```ts
  { items: TransferRecord[], nextCursor: string | null }
  ```

  `TransferRecord` is the domain shape from §4 — JSON-safe (all strings/numbers).

- Response headers: `Cache-Control: private, max-age=30`. Telegram WebView reloads the mini app aggressively on focus; this lets the browser short-circuit identical refetches inside the BE-cache TTL window without involving Redis at all.
- Error mapping: `RateLimitedError` → 429 `{ error: "rate-limited", retryAfterSec }`; `UnsupportedChainError` → 400; anything else → 500.
- Logging mirrors `/loyalty/history`: `log.info({ userId, route: "GET /transfers", durationMs, count }, "request-served")`.

No FE schema break — this is an additive route. Pagination shape mirrors `/loyalty/history`'s cursor pattern so the FE hook can be a near-copy of `useLoyalty`.

---

## 9. Agent tool — `get_transfer_history`

### 9.1 Tool type registration

`helpers/enums/toolType.enum.ts`:

```ts
export enum TOOL_TYPE {
  WEB_SEARCH = "web_search",
  EXECUTE_INTENT = "execute_intent",
  GET_PORTFOLIO = "get_portfolio",
  GET_TRANSFER_HISTORY = "get_transfer_history",   // NEW
}
```

### 9.2 Tool implementation

`adapters/implementations/output/tools/getTransferHistory.tool.ts` — mirrors `getPortfolio.tool.ts` shape exactly so the tool registry / dispatcher loop is unchanged.

```ts
// Tool input shape — resolved §15.1: windowDays replaces fromEpoch/toEpoch.
// The use case still accepts epoch bounds (HTTP route exposes them); the tool
// just translates `windowDays` → `[now - windowDays*86400, now]` before calling
// the use case. Cuts a few tokens per LLM turn and matches how the user phrases
// the query ("last week", "last month").
const InputSchema = z.object({
  windowDays: z.number().int().min(1).max(365).optional()
    .describe("How many days back to look, ending now. E.g. 1 = last 24h, 7 = last week, 30 = last month. Omit for unbounded."),
  direction: z.enum(["in", "out", "self"]).optional()
    .describe("Filter to one direction. Omit for all."),
  limit:     z.number().int().min(1).max(100).optional()
    .describe("Page size, default 25, max 100."),
});

class GetTransferHistoryTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly useCase: ITransferHistoryUseCase,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.GET_TRANSFER_HISTORY,
      description:
        "Look up the user's on-chain transfer history (sends + receives, native + ERC-20) " +
        "for their Smart Contract Account on the configured chain. Use when the user asks " +
        "about past activity, spending, receipts, or who paid them. Returns a Markdown table.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    // log.info({ step: 'started', userId, ... }, "history-tool"); etc.
    // Call use case with userId from constructor + parsed input.
    // Format the page into a Markdown table identical in shape to GetPortfolioTool's output:
    //   "When | Direction | Token | Amount | Counterparty | Label | Tx"
    // (Label column added per §15.2; "—" when the row has no Aegis label.)
    // so the LLM can read & paraphrase.
    // On RateLimitedError return { success: false, error: "history-rate-limited" } — the
    // dispatcher surfaces this as a graceful "try again in a minute" reply.
  }
}
```

### 9.3 Wiring into the system tool provider

`SystemToolProviderConcrete.getTools` adds:

```ts
new GetTransferHistoryTool(userId, this.transferHistoryUseCase),
```

`assistant.di.ts` constructs `transferHistoryUseCase` once per process, but the **cached decorator factory is per-userId** (so the per-user rate guard binds correctly). Pattern:

```ts
getTransferHistoryUseCase(userId: string): ITransferHistoryUseCase {
  const ankr   = this._ankrTransferHistory ??= new AnkrTransferHistoryProvider({...});
  const cache  = this._txHistoryCache       ??= new RedisTransferHistoryCache(this.getRedis());
  const cached = new CachedTransferHistoryProvider(ankr, cache, userId);
  return new TransferHistoryUseCaseImpl(this.getUserProfileDB(), cached, this.getChainId());
}
```

Note for the DI author: the `SystemToolProviderConcrete.getTools(userId, conversationId)` already takes `userId`, so threading it into `getTransferHistoryUseCase(userId)` is a one-line change in the provider.

### 9.4 Agent loop integration (no flow change)

The flow the user described is **already** how the assistant loop works today (`assistant.usecase.ts` → tool dispatch → tool result patched back into the LLM context → next LLM turn produces the user-facing message). Adding the tool to `SystemToolProviderConcrete` is sufficient — no changes to the loop, dispatcher, or capability registry. The LLM picks the tool by name from its description.

---

## 10. DI wiring

`be/src/adapters/inject/assistant.di.ts`:

- `getAnkrTransferHistoryProvider()` — singleton, like `getBalanceProvider`.
- `getTransferHistoryCache()` — singleton, Redis-backed.
- `getTransferHistoryUseCase(userId)` — per-user (see §9.3).
- HTTP route receives the use case via the same `(req → userId → useCase)` shape used by `/loyalty/history`.

Both `telegramCli.ts` and `workerCli.ts` need no changes — they already share `assistant.di.ts`.

---

## 11. File-level checklist

| Action | Path |
|---|---|
| NEW | `be/src/use-cases/interface/output/blockchain/transferHistoryProvider.interface.ts` |
| NEW | `be/src/use-cases/interface/output/cache/transferHistory.cache.ts` |
| NEW | `be/src/use-cases/interface/input/transferHistory.interface.ts` |
| NEW | `be/src/use-cases/implementations/transferHistory.usecase.ts` |
| NEW | `be/src/adapters/implementations/output/transferHistory/ankrTransferHistoryProvider.ts` |
| NEW | `be/src/adapters/implementations/output/transferHistory/cachedTransferHistoryProvider.ts` |
| NEW | `be/src/adapters/implementations/output/cache/redis.transferHistory.ts` |
| NEW | `be/src/adapters/implementations/output/tools/getTransferHistory.tool.ts` |
| EDIT | `be/src/helpers/enums/toolType.enum.ts` — add `GET_TRANSFER_HISTORY` |
| EDIT | `be/src/adapters/implementations/output/systemToolProvider.concrete.ts` — register tool |
| EDIT | `be/src/adapters/implementations/input/http/httpServer.ts` — add `GET /transfers` route + handler |
| EDIT | `be/src/adapters/inject/assistant.di.ts` — wire provider, cache, use-case factory; pass `sqlDB.intentExecutions` for label enrichment |
| EDIT | `be/src/use-cases/interface/output/repository/intentExecution.repo.ts` — add `findByTxHashes(userId, hashes[])` |
| EDIT | `be/src/adapters/implementations/output/sqlDB/repositories/intentExecution.repo.ts` — implement `findByTxHashes` (lowercased `inArray` over `lower(tx_hash)`) |
| NEW | `be/src/helpers/errors/rateLimitedError.ts` |
| NEW | `be/src/helpers/errors/unsupportedChainError.ts` |
| EDIT | `be/src/helpers/env/` — add `TRANSFER_HISTORY_RPM_USER` (default 3), `TRANSFER_HISTORY_RPS_GLOBAL` (default 10), `TRANSFER_HISTORY_PAGE_TTL_SEC` (default 60), `TRANSFER_HISTORY_STALE_TTL_SEC` (default 900) |
| EDIT | `.env.example` — document new envs (no new secret; reuses `ANKR_API_KEY`) |
| EDIT | `be/src/adapters/implementations/output/capabilities/status.md` — record convention notes (see §14) |

No DB migrations. No Drizzle schema change. The only persistence is Redis cache, which is operational state.

---

## 12. Logging contract (CLAUDE.md compliance)

Module scopes:

- `AnkrTransferHistoryProvider` — `→`/`←` debug per upstream call, `warn` on retry, `error` on failure, `info` on `history-fetched`.
- `CachedTransferHistoryProvider` — `debug { choice: 'hit'|'miss' }` on every lookup; `warn { userId } "history-rate-limited"` on quota exhaust.
- `RedisTransferHistoryCache` — `debug` on read/write; `error { err }` on Redis failure (degrade to no-cache, do not block).
- `TransferHistoryUseCase` — `info { step }` lifecycle (`started`, `succeeded`, `failed`) with `userId`, `requestId`, `durationMs`, `count`.
- HTTP handler — `info { userId, route: "GET /transfers", durationMs, count }`.
- `GetTransferHistoryTool` — `info { step, userId, requestId }` per `started`/`succeeded`/`failed`; `debug { argCount, direction, fromEpoch, toEpoch }` on entry.

Privacy: never log raw API key, never log full counterparty addresses at `info`/`warn` (truncate at `debug`).

---

## 13. Test plan

- **Unit — `AnkrTransferHistoryProvider`:** mock `fetch`, assert merge of `getTransactionsByAddress` + `getTokenTransfers` on `(txHash, logIndex)`, native vs ERC-20 mapping, direction derivation, sort order, retry behaviour, `UnsupportedChainError` for Fuji.
- **Unit — `CachedTransferHistoryProvider`:** TTL hit/miss, rate-guard exhaustion path throws `RateLimitedError` and does not call `inner`, errors not cached.
- **Unit — `RedisTransferHistoryCache`:** sliding-window counter behaviour at the boundary, JSON round-trip, missing-key returns null.
- **Unit — Use case:** profile-not-found → empty page, limit clamping, error mapping.
- **Integration (manual):** hit `/transfers` for a known wallet on Avalanche mainnet — verify both inbound (e.g. CEX deposit) and outbound (e.g. an Aegis send) appear, USD totals roughly match Snowtrace.
- **Tool regression:** in a staging conversation, ask *"what did I receive last week"* — confirm the LLM picks `get_transfer_history` with a sensible `fromEpoch`/`direction`, the tool returns a Markdown table, and the next LLM turn paraphrases it correctly.
- **Rate-limit regression:** issue 7 cursor pages back-to-back — 7th must 429 with `retryAfterSec`, not bleed Ankr quota.

---

## 14. New conventions to record in `status.md`

- `ITransferHistoryProvider` is the single port for any "list of past on-chain movements" query. Future RPC ingester or alt-vendor adapter must implement this interface — do not add a parallel port.
- The cached decorator pattern (`CachedTransferHistoryProvider`) sets the precedent for **per-user** rate guards on free-tier external providers. Re-use the same shape (`acquireUpstreamSlot(userId)`) on any future external integration with strict free-tier limits.
- New log metadata field: `count` (page size returned). Already present elsewhere; reaffirm.
- New error type: `RateLimitedError` — generic enough to live in `helpers/errors/`. Use it for any provider-side rate-limit, not just Ankr.

---

## 15. Open questions

1. ~~**Time-window vocabulary in the tool.**~~ **Resolved:** the agent tool exposes `windowDays?: number` (1..365) and translates to epochs internally. `fromEpoch`/`toEpoch` remain on the use-case + HTTP query (FE controls precise windows). Tool no longer accepts epoch fields directly.
2. ~~**Labelled activity.**~~ **Resolved (in scope):** use case enriches rows whose `txHash` matches an `intent_executions` row for the same `userId`. Label is derived from `solverUsed` via `buildLabel()` (e.g. `"swap via Relay"`, `"send"`, `"yield via <id>"`); unrecognised solvers fall through to `"via <solverUsed>"`. `IIntentExecutionDB.findByTxHashes(userId, hashes[])` was added (lowercased SQL match). Best-effort: lookup failures log `warn` and yield unlabelled rows.
3. ~~**Multi-chain in v1.**~~ **Deferred.** Stays single-chain matching `PortfolioUseCase`. The port shape (`chainId: number`) leaves the door open for a future fan-out adapter without source-breaking callers.
4. **Cache backing.** Defaulted to Redis (matches `cache/redis.*`, survives BE replicas, is the natural place for the rate guard). Push back if you'd prefer in-memory + a separate Redis rate guard, like the balance provider does.
5. ~~Rate-guard policy when busy.~~ **Resolved (§6.3):** per-user gate throws (intentional self-protection); global gate serves stale-up-to-15-min before throwing.

---

## 15a. Implementation notes (2026-05-04)

- **`getTransferHistoryUseCase()` returns `undefined` for chains with no Ankr support** (e.g. Fuji 43113). Effects: `HttpApiServer` returns 503 for `GET /transfers`, and `SystemToolProviderConcrete` does not register `get_transfer_history` for that user's tool list. Plan §5.2 originally called for runtime `UnsupportedChainError`; failing fast at boot avoids dead routes/tools. Easy to flip back if you'd rather see the explicit error.
- **Cursor is opaque JSON `{tx, token}`.** The two Ankr endpoints (`getTransactionsByAddress`, `getTokenTransfers`) advance independently. The adapter encodes both tokens in one cursor and the cached decorator/HTTP/agent treat it as a string blob.
- **Without Redis the cached decorator is bypassed** (use raw Ankr) instead of throwing — matches §6.5 "best-effort" rule.
- **Label table column is added to the agent tool's Markdown output** (`Label` column, `—` when null). The HTTP route just passes the `label` field through on each row.
- **`findByTxHashes` matches case-insensitively** via `lower(tx_hash)` so callers don't have to worry about checksum vs. lowercased hashes from different sources. The use case lowercases inputs before querying.

## 16. Scale target

Sized for **<1k DAU** on Ankr Advanced free tier with the existing balance provider sharing the same key. Headroom: per-user 3 rpm, global 10 rps, day-bucketed cache keys, 60 s fresh / 15 min stale. No DB writes, no schema migration, no in-process state — every cache and counter lives in Redis so the BE can scale to N replicas without coordination. Revisit numbers when telemetry shows >50% gate hit rate or >30% stale-serve rate; that's the signal to either lift Ankr to paid or start the in-house ingester deferred in §1.
